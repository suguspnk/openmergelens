import { readFile } from 'node:fs/promises';
import {
  createReviewMarker,
  currentUsername,
  getPullRequest,
  getPullRequestDiff,
  hasActiveReviewRequest,
  isValidatedReviewRequestSearchResult,
  prepareReview,
  postReview,
  reviewAlreadyPosted,
  searchReviewRequestedPRs,
} from './github.mjs';
import { authEnvironment, resolveGitHubAuth } from './github-auth.mjs';
import { hasAiProcessingConsent } from './ai-processing-consent.mjs';
import { accountKey, accountLabel } from './config.mjs';
import {
  createGitHubMutationCadence,
  createGitHubMutationQueue,
} from './github-mutation-queue.mjs';
import { readLearnings } from './learnings.mjs';
import { createLogger } from './logging.mjs';
import {
  processInBatches,
  processWithConcurrency,
  resolveReviewBatchSize,
} from './poll-batching.mjs';
import {
  roundRobinAccountQueues,
  selectConfiguredAccounts,
} from './poll-queue.mjs';
import { ensureReviewPrompt } from './review-prompts.mjs';
import { createReviewAdmissionGate } from './review-admission.mjs';
import { invokeMultiPassReview } from './reviewer-adapter.mjs';
import { reviewerCommandForGitHubHost } from './reviewer-command-defaults.mjs';
import { describeReviewerModel } from './reviewer-models.mjs';
import { buildReviewerEnvironment } from './reviewer-security.mjs';
import {
  ReviewMutationBoundaryError,
  mutationBoundaryReason,
} from './review-mutation-boundary.mjs';
import {
  MAX_CONFIGURED_REVIEW_SCOPES,
  MAX_REVIEW_STATE_ENTRIES,
  MAX_REVIEWS_PER_POLL,
  MAX_STATE_GC_CHECKS_PER_POLL,
  MAX_STATE_FILE_BYTES,
} from './security-limits.mjs';
import {
  expireReviewState,
  loadState,
  migrateLegacyStateForReviewer,
  needsReview,
  normalizeState,
  parsePrKey,
  prKey,
  candidateCursorFor,
  recordCandidateCursor,
  recordReview,
  recordReviewStateGcAfterKey,
  recordReviewStateProofOrder,
  reviewScopeKey,
  reviewStateEntryCount,
  reviewStateGcAfterKey,
  reviewStateNeedsProofMetadataMigration,
  saveState,
  serializeState,
  STATE_METADATA_KEY,
} from './state.mjs';

const MAX_CONCURRENT_ACCOUNT_DISCOVERIES = 5;
// Capacity admission runs before historical closure GC. Keep one shared-budget
// operation available so a full run of unsuccessful marker proofs cannot
// indefinitely prevent direct closure checks from advancing.
const MAX_STATE_PROOF_CHECKS_PER_POLL = MAX_STATE_GC_CHECKS_PER_POLL - 1;
// Admit a small cushion of candidates beyond the review cap so unchanged or
// closed candidates do not consume the whole poll's chance to find actionable
// work. Candidates beyond this window stay queued for the next poll. The
// window bounds candidate metadata reads; review-time head confirmations are
// still required for admitted reviews and are bounded by MAX_REVIEWS_PER_POLL.
export const MAX_CANDIDATE_METADATA_PER_POLL = MAX_REVIEWS_PER_POLL + 5;

function configuredReviewScopeUniverse(config) {
  const scopes = new Set();
  for (const account of config.githubAccounts) {
    const reviewer = accountKey(account);
    for (const repo of account.repositories) {
      scopes.add(`${reviewer}::${repo.toLowerCase()}`);
      if (scopes.size > MAX_CONFIGURED_REVIEW_SCOPES) {
        throw new Error(
          `config.json exceeds ${MAX_CONFIGURED_REVIEW_SCOPES} configured review scopes`,
        );
      }
    }
  }
  return scopes;
}

function reviewEntryBytes(key, entry) {
  // Count only the canonical key/record JSON payload for scope fairness.
  // File-level admission still uses serializeState(), including formatting and
  // scheduler metadata, so this accounting cannot weaken the global limit.
  return Buffer.byteLength(JSON.stringify([key, entry]), 'utf8');
}

function compareCodeUnits(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function cloneReviewState(state) {
  return normalizeState(state);
}

function accountLogger(account, logger) {
  const label = accountLabel(account);
  const scopedLogger = logger.child({ account: label });
  return {
    label,
    info(message, options) {
      return scopedLogger.info(message, options);
    },
    warn(message, options) {
      return scopedLogger.warn(message, options);
    },
    error(message, options) {
      return scopedLogger.error(message, options);
    },
    output(message) {
      return scopedLogger.output(message);
    },
  };
}

function requestedCandidateForRepository(candidate, repo) {
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    typeof candidate.repo !== 'string' ||
    !Number.isSafeInteger(candidate.number) ||
    candidate.number <= 0
  ) {
    return { candidate: null, reason: 'malformed' };
  }
  if (candidate.repo.toLowerCase() !== repo.toLowerCase()) {
    return { candidate: null, reason: 'foreign repository' };
  }
  return {
    candidate: {
      repo: candidate.repo,
      number: candidate.number,
    },
  };
}

function hasTrustedSearchProvenance(candidates, verifyProvenance) {
  try {
    return verifyProvenance(candidates) === true;
  } catch {
    return false;
  }
}

function pullRequestMetadataError(pr) {
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
    return 'expected an object';
  }
  if (typeof pr.state !== 'string') {
    return 'expected a state string';
  }
  if (typeof pr.headRefOid !== 'string' || pr.headRefOid.trim() === '') {
    return 'expected a non-empty headRefOid string';
  }
  return null;
}

function candidateCursorKey(account, repo, source) {
  return `${accountKey(account)}::${repo.toLowerCase()}::${source}`;
}

function rotateCandidateGroup(
  candidates,
  { account, repo, source, state },
) {
  if (candidates.length === 0) return [];
  const cursorKey = candidateCursorKey(account, repo, source);
  const start = candidateCursorFor(state, cursorKey) % candidates.length;
  const rotated = [
    ...candidates.slice(start),
    ...candidates.slice(0, start),
  ];
  return rotated.map((candidate, index) => ({
    ...candidate,
    candidateCursor: {
      key: cursorKey,
      start,
      length: candidates.length,
      index,
    },
  }));
}

async function timedStep(logger, message, fn) {
  logger.info(`${message}...`);
  const start = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    logger.info(`${message}: done (${durationMs}ms)`, {
      event: 'step.completed',
      fields: { durationMs },
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.warn(`${message}: failed (${durationMs}ms)`, {
      event: 'step.failed',
      fields: { durationMs },
      error: err,
    });
    throw err;
  }
}

export async function pollOnce(options) {
  const {
    logPath,
    logger: suppliedLogger,
  } = options;
  const logger = suppliedLogger || createLogger({
    logPath,
    consoleMode: process.env.OPENMERGELENS_SCHEDULED === '1' ? 'none' : 'human',
  });
  try {
    return await pollOnceInternal({ ...options, logger });
  } finally {
    if (!suppliedLogger) await logger.flush();
  }
}

async function pollOnceInternal({
  config,
  stateFile,
  defaultReviewPromptPath,
  dryRun = false,
  accountSelector,
  logger: pollLogger,
  dependencies = {},
}) {
  const services = {
    resolveGitHubAuth,
    currentUsername,
    searchReviewRequestedPRs,
    isValidatedReviewRequestSearchResult,
    getPullRequest,
    getPullRequestForStateGc: getPullRequest,
    getPullRequestDiff,
    hasActiveReviewRequest,
    prepareReview,
    createReviewMarker,
    reviewAlreadyPosted,
    ensureReviewPrompt,
    readPrompt: (promptPath) => readFile(promptPath, 'utf8'),
    readLearnings,
    invokeMultiPassReview,
    postReview,
    createGitHubMutationCadence,
    createGitHubMutationQueue,
    createReviewAdmissionGate,
    now: () => Date.now(),
    // Keep the injected loader's existing one-argument contract while making
    // the built-in loader aware of dry-run's no-metadata-write guarantee.
    loadState: (statePath) => loadState(statePath, { hardenPermissions: !dryRun }),
    saveState,
    ...dependencies,
  };
  const configuredReviewScopes = configuredReviewScopeUniverse(config);
  const accounts = selectConfiguredAccounts(config.githubAccounts, accountSelector);
  const reviewMutationCadence = services.createGitHubMutationCadence();
  const githubSchedulers = new Map();
  function scheduleGitHubOperationFor(account) {
    const key = accountKey(account);
    let scheduler = githubSchedulers.get(key);
    if (!scheduler) {
      const queue = services.createGitHubMutationQueue();
      scheduler = (operation, options) => queue.run(operation, options);
      githubSchedulers.set(key, scheduler);
    }
    return scheduler;
  }
  const reviewAdmission = services.createReviewAdmissionGate();
  const loadedState = await services.loadState(stateFile);
  const experimentalProofMetadataPresent =
    reviewStateNeedsProofMetadataMigration(loadedState);
  const { normalizedState: state } = serializeState(
    loadedState,
    { stateFile },
  );
  let failed = false;
  const accountQueues = [];
  const authenticatedReviewScopes = new Map();
  const failures = [];
  const candidateCursorProgress = new Map();
  const candidateCursorPlans = new Map();
  const reservedReviewState = new Map();
  const pendingReviewStateReservationKeys = new Set();
  const admissionProtectedReviewStateKeys = new Set();
  const claimedReviewStateProofKeys = new Set();
  let reviewStateProofOrder = [];
  let reviewStateProofOrderDirty = false;
  let stateMaintenanceOperationsUsed = 0;
  let stateWriteQueue = Promise.resolve();
  let stateAdmissionQueue = Promise.resolve();

  async function recordFailure(entry, label, message, error) {
    failed = true;
    const failure = { status: 'failed', ...entry };
    failures.push(failure);
    await pollLogger.error(message, {
      event: 'poll.failure',
      fields: { ...entry, scope: label },
      error,
    });
    return failure;
  }

  if (experimentalProofMetadataPresent && !dryRun) {
    try {
      await services.saveState(stateFile, state);
    } catch (err) {
      await recordFailure(
        {
          subject: 'review state',
          note: 'proof metadata migration failed',
        },
        'review state',
        `review state proof metadata migration failed: ${err.message}`,
        err,
      );
      return { failed, reviewed: 0, outcomes: [], failures };
    }
  }

  function restoreState(snapshot) {
    for (const key of Object.keys(state)) delete state[key];
    for (const [key, value] of Object.entries(snapshot)) {
      Object.defineProperty(state, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
  }

  function withStateWriteQueue(operation) {
    const write = stateWriteQueue.then(operation);
    stateWriteQueue = write.catch(() => {});
    return write;
  }

  function withStateAdmissionQueue(operation) {
    const admission = stateAdmissionQueue.then(operation);
    stateAdmissionQueue = admission.catch(() => {});
    return admission;
  }

  function projectedState(extraReservation, verifiedMarkerEntries = new Map()) {
    const projected = cloneReviewState(state);
    for (const [key, originalEntry] of verifiedMarkerEntries) {
      if (state[key] !== originalEntry) continue;
      projected[key] = { ...originalEntry, reviewMarkerVersion: 1 };
    }
    for (const reservation of reservedReviewState.values()) {
      projected[reservation.key] = reservation.entry;
    }
    if (extraReservation) {
      projected[extraReservation.key] = extraReservation.entry;
    }
    return projected;
  }

  function stateUsage(projected) {
    const { serializedBytes } = serializeState(projected, {
      stateFile,
      enforceEntryLimit: false,
      enforceByteLimit: false,
    });
    return {
      entries: reviewStateEntryCount(projected),
      bytes: serializedBytes,
    };
  }

  function assertProjectedCapacity(extraReservation) {
    const usage = stateUsage(projectedState(extraReservation));
    if (
      usage.entries > MAX_REVIEW_STATE_ENTRIES ||
      usage.bytes > MAX_STATE_FILE_BYTES
    ) {
      throw new Error(
        `review state capacity would exceed ${MAX_REVIEW_STATE_ENTRIES} entries ` +
        `or ${MAX_STATE_FILE_BYTES} bytes`,
      );
    }
  }

  function persistStateBatch(change) {
    return withStateWriteQueue(async () => {
      const snapshot = cloneReviewState(state);
      change();
      try {
        assertProjectedCapacity();
        await services.saveState(stateFile, state);
      } catch (err) {
        restoreState(snapshot);
        throw err;
      }
    });
  }

  function persistStateChange(_key, change) {
    return persistStateBatch(change);
  }

  function persistReview(reservation) {
    return persistStateChange(reservation.key, () => {
      recordReview(
        state,
        reservation.key,
        reservation.entry.lastReviewedSha,
        reservation.entry.lastReviewedAt,
        { reviewMarkerVersion: reservation.entry.reviewMarkerVersion },
      );
    });
  }

  function retireTrackedState(key) {
    if (state[key] === undefined) return Promise.resolve();
    return persistStateChange(key, () => {
      delete state[key];
    });
  }

  function stateScopeMetrics(projected) {
    const metrics = new Map();
    for (const [key, entry] of Object.entries(projected)) {
      if (key === STATE_METADATA_KEY) continue;
      const scope = reviewScopeKey(key);
      if (!scope) continue;
      let metric = metrics.get(scope);
      if (!metric) {
        metric = { count: 0, bytes: 0 };
        metrics.set(scope, metric);
      }
      metric.count += 1;
      metric.bytes += reviewEntryBytes(key, entry);
    }
    return metrics;
  }

  function normalizedOverage(value, floor) {
    if (value <= floor) return 0;
    return floor === 0 ? Number.POSITIVE_INFINITY : (value - floor) / floor;
  }

  function advanceReviewStateProofOrder(scope, key) {
    const scopeKeys = reviewStateProofOrder.filter((candidate) =>
      reviewScopeKey(candidate) === scope,
    );
    if (!scopeKeys.includes(key)) return;
    reviewStateProofOrder = [
      ...reviewStateProofOrder.filter((candidate) =>
        reviewScopeKey(candidate) !== scope,
      ),
      ...scopeKeys.filter((candidate) => candidate !== key),
      key,
    ];
    reviewStateProofOrderDirty = true;
  }

  async function persistReviewStateProofOrder() {
    if (dryRun || !reviewStateProofOrderDirty) return;
    try {
      await persistStateBatch(() => {
        recordReviewStateProofOrder(state, reviewStateProofOrder);
      });
      reviewStateProofOrderDirty = false;
    } catch (err) {
      await recordFailure(
        {
          subject: 'review state',
          note: 'proof queue persistence failed',
        },
        'review state',
        `review state proof queue persistence failed: ${err.message}`,
        err,
      );
    }
  }

  function reclaimChoice(
    projected,
    usage,
    {
      currentKey,
      verifiedMarkerEntries,
      excludedKeys = new Set(),
      markerMode = 'proven',
      scopeFilter = null,
      entryOrder = null,
    },
  ) {
    const entryPressure = usage.entries > MAX_REVIEW_STATE_ENTRIES;
    const bytePressure = usage.bytes > MAX_STATE_FILE_BYTES;
    if (!entryPressure && !bytePressure) return null;

    const scopeCount = configuredReviewScopes.size;
    const configuredEntryFloor = Math.floor(MAX_REVIEW_STATE_ENTRIES / scopeCount);
    const configuredByteFloor = Math.floor(MAX_STATE_FILE_BYTES / scopeCount);
    const metrics = stateScopeMetrics(projected);
    const reservedKeys = new Set(reservedReviewState.keys());
    const candidates = new Map();
    const entries = entryOrder === null
      ? Object.entries(state)
      : entryOrder.map((key) => [key, state[key]]);
    for (const [key, entry] of entries) {
      if (
        key === STATE_METADATA_KEY ||
        entry === undefined ||
        key === currentKey ||
        excludedKeys.has(key) ||
        admissionProtectedReviewStateKeys.has(key) ||
        reservedKeys.has(key)
      ) continue;
      const scope = reviewScopeKey(key);
      if (!scope || (scopeFilter !== null && !scopeFilter(scope))) continue;
      const metric = metrics.get(scope);
      if (!metric) continue;
      const configured = configuredReviewScopes.has(scope);
      const entryFloor = configured ? configuredEntryFloor : 0;
      const byteFloor = configured ? configuredByteFloor : 0;
      const verifiedEntry = verifiedMarkerEntries.get(key);
      const proven = entry.reviewMarkerVersion === 1 ||
        (verifiedEntry !== undefined && state[key] === verifiedEntry);
      if (
        (markerMode === 'proven' && !proven) ||
        (markerMode === 'unproven' && proven)
      ) continue;

      const bytes = reviewEntryBytes(key, projected[key] ?? entry);
      const preservesEntryFloor = !entryPressure ||
        metric.count - 1 >= entryFloor;
      const preservesByteFloor = !bytePressure ||
        metric.bytes - bytes >= byteFloor;
      if (!preservesEntryFloor || !preservesByteFloor) continue;

      const candidate = { key, entry, bytes };
      let scoped = candidates.get(scope);
      if (!scoped) {
        scoped = { first: null, oldest: null };
        candidates.set(scope, scoped);
      }
      if (markerMode === 'unproven') {
        if (scoped.first === null) scoped.first = candidate;
      } else {
        const candidateTime = Date.parse(entry.lastReviewedAt);
        const oldestTime = scoped.oldest === null
          ? Number.POSITIVE_INFINITY
          : Date.parse(scoped.oldest.entry.lastReviewedAt);
        if (
          candidateTime < oldestTime ||
          (
            candidateTime === oldestTime &&
            compareCodeUnits(key, scoped.oldest.key) < 0
          )
        ) {
          scoped.oldest = candidate;
        }
      }
    }

    let donor = null;
    for (const [scope, candidatesForScope] of candidates) {
      const metric = metrics.get(scope);
      const configured = configuredReviewScopes.has(scope);
      const entryFloor = configured ? configuredEntryFloor : 0;
      const byteFloor = configured ? configuredByteFloor : 0;
      const score = Math.max(
        entryPressure ? normalizedOverage(metric.count, entryFloor) : 0,
        bytePressure ? normalizedOverage(metric.bytes, byteFloor) : 0,
      );
      const victim = markerMode === 'unproven'
        ? candidatesForScope.first
        : candidatesForScope.oldest;
      if (
        donor === null ||
        (
          markerMode !== 'unproven' &&
          (
            score > donor.score ||
            (score === donor.score && compareCodeUnits(scope, donor.scope) < 0)
          )
        )
      ) {
        donor = { scope, score, victim };
      }
    }
    return donor?.victim ?? null;
  }

  function planReviewStateAdmission(
    reservation,
    verifiedMarkerEntries = new Map(),
  ) {
    const working = projectedState(reservation, verifiedMarkerEntries);
    const victims = [];
    const excludedKeys = new Set();
    let usage = stateUsage(working);

    while (
      usage.entries > MAX_REVIEW_STATE_ENTRIES ||
      usage.bytes > MAX_STATE_FILE_BYTES
    ) {
      const choice = reclaimChoice(working, usage, {
        currentKey: reservation.key,
        verifiedMarkerEntries,
        excludedKeys,
        markerMode: 'proven',
      });
      if (!choice) {
        return { fits: false, victims, working, usage, excludedKeys };
      }
      victims.push(choice.key);
      excludedKeys.add(choice.key);
      delete working[choice.key];
      usage = stateUsage(working);
    }

    return { fits: true, victims, working, usage, excludedKeys };
  }

  function authenticatedScope(scopeKey) {
    return authenticatedReviewScopes.get(scopeKey) ?? null;
  }

  async function proveReviewMarker(key, entry) {
    const parsed = parsePrKey(key);
    const scopeKey = reviewScopeKey(key);
    const scope = scopeKey ? authenticatedScope(scopeKey) : null;
    if (!parsed?.reviewer || !scope) {
      return { proven: false, remotelyChecked: false };
    }
    const logger = accountLogger(scope.account, pollLogger);
    const marker = services.createReviewMarker({
      account: scope.account,
      repo: parsed.repo,
      number: parsed.number,
      commitId: entry.lastReviewedSha,
    });
    try {
      const proven = await scope.scheduleGitHubOperation(() =>
        services.reviewAlreadyPosted({
          repo: parsed.repo,
          number: parsed.number,
          commitId: entry.lastReviewedSha,
          marker,
          auth: scope.auth,
        }),
      ) === true;
      return { proven, remotelyChecked: true };
    } catch (err) {
      await logger.warn(
        `historical marker proof failed for ${parsed.repo}#${parsed.number}: ${err.message}`,
        {
          event: 'state.marker_proof.failed',
          fields: {
            repo: parsed.repo,
            number: parsed.number,
            scope: logger.label,
          },
          error: err,
        },
      );
      return { proven: false, remotelyChecked: true };
    }
  }

  function reservationRelease(reservation) {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await withStateAdmissionQueue(() => withStateWriteQueue(() => {
        if (reservedReviewState.get(reservation.key) === reservation) {
          reservedReviewState.delete(reservation.key);
        }
      }));
    };
  }

  async function reserveReviewStateCapacity(reservation) {
    await withStateAdmissionQueue(() => {
      if (
        reservedReviewState.has(reservation.key) ||
        pendingReviewStateReservationKeys.has(reservation.key)
      ) {
        throw new Error(`review state key ${reservation.key} is already reserved`);
      }
      pendingReviewStateReservationKeys.add(reservation.key);
      admissionProtectedReviewStateKeys.add(reservation.key);
    });
    try {
      const verifiedMarkerEntries = new Map();
      const attemptedProofs = new Set();

      while (true) {
        const attempt = await withStateAdmissionQueue(() => withStateWriteQueue(async () => {
          for (const [key, originalEntry] of verifiedMarkerEntries) {
            if (state[key] !== originalEntry) verifiedMarkerEntries.delete(key);
          }
          const plan = planReviewStateAdmission(
            reservation,
            verifiedMarkerEntries,
          );
          if (!plan.fits) {
            const proof = reclaimChoice(plan.working, plan.usage, {
              currentKey: reservation.key,
              verifiedMarkerEntries,
              excludedKeys: new Set([
                ...plan.excludedKeys,
                ...attemptedProofs,
                ...claimedReviewStateProofKeys,
              ]),
              markerMode: 'unproven',
              scopeFilter: (scopeKey) => authenticatedScope(scopeKey) !== null,
              entryOrder: reviewStateProofOrder,
            });
            if (
              !proof ||
              stateMaintenanceOperationsUsed >= MAX_STATE_PROOF_CHECKS_PER_POLL
            ) {
              throw new Error(
                `review state capacity reached at ${plan.usage.entries} entries ` +
                `and ${plan.usage.bytes} bytes`,
              );
            }
            const proofScope = reviewScopeKey(proof.key);
            advanceReviewStateProofOrder(proofScope, proof.key);
            claimedReviewStateProofKeys.add(proof.key);
            stateMaintenanceOperationsUsed += 1;
            return { proof };
          }

          const snapshot = cloneReviewState(state);
          let stateChanged = false;
          try {
            for (const [key, originalEntry] of verifiedMarkerEntries) {
              if (state[key] !== originalEntry) continue;
              state[key] = { ...originalEntry, reviewMarkerVersion: 1 };
              stateChanged = true;
            }
            for (const key of plan.victims) {
              if (state[key] === undefined) continue;
              delete state[key];
              stateChanged = true;
            }
            reservedReviewState.set(reservation.key, reservation);
            assertProjectedCapacity();
            if (stateChanged) await services.saveState(stateFile, state);
          } catch (err) {
            reservedReviewState.delete(reservation.key);
            restoreState(snapshot);
            throw err;
          }
          return { release: reservationRelease(reservation) };
        }));

        if (attempt.release) return attempt.release;
        attemptedProofs.add(attempt.proof.key);
        try {
          const proofResult = await proveReviewMarker(
            attempt.proof.key,
            attempt.proof.entry,
          );
          if (proofResult.proven) {
            verifiedMarkerEntries.set(attempt.proof.key, attempt.proof.entry);
          }
        } finally {
          await withStateAdmissionQueue(() => {
            claimedReviewStateProofKeys.delete(attempt.proof.key);
          });
        }
      }
    } finally {
      await withStateAdmissionQueue(() => {
        pendingReviewStateReservationKeys.delete(reservation.key);
      });
    }
  }

  const legacyStateIsAmbiguous = config.githubAccounts.length > 1 && Object.keys(state).some((key) => {
    const parsed = parsePrKey(key);
    return parsed?.reviewer === null;
  });
  if (legacyStateIsAmbiguous) {
    pollLogger.info(
      'legacy unscoped review state retained: multiple configured accounts make ' +
      'the previous reviewer ambiguous',
    );
  }

  if (config.githubAccounts.length === 1) {
    const snapshot = normalizeState(state);
    const migrated = migrateLegacyStateForReviewer(state, accounts[0]);
    if (migrated && !dryRun) {
      try {
        await services.saveState(stateFile, state);
      } catch (err) {
        restoreState(snapshot);
        await recordFailure(
          {
            subject: 'review state',
            account: accountLabel(accounts[0]),
            note: 'legacy state migration failed',
          },
          accountLabel(accounts[0]),
          `legacy review state migration failed: ${err.message}`,
          err,
        );
        return { failed, reviewed: 0, outcomes: [], failures };
      }
    }
  }

  if (!dryRun) {
    const snapshot = normalizeState(state);
    const expiredKeys = expireReviewState(state, services.now());
    if (expiredKeys.length > 0) {
      try {
        await services.saveState(stateFile, state);
        pollLogger.info(
          `expired ${expiredKeys.length} review state entr${expiredKeys.length === 1 ? 'y' : 'ies'} ` +
          'older than 365 days',
        );
      } catch (err) {
        restoreState(snapshot);
        await recordFailure(
          {
            subject: 'review state',
            note: 'retention cleanup failed',
          },
          'review state',
          `review state retention cleanup failed: ${err.message}`,
          err,
        );
        return { failed, reviewed: 0, outcomes: [], failures };
      }
    }
  }

  reviewStateProofOrder = Object.keys(state)
    .filter((key) => key !== STATE_METADATA_KEY);

  // The bounded maintenance sweep covers only records present after startup
  // migration/expiry. Reviews written by this poll have just been reconciled
  // and must not spend another remote operation immediately.
  const historicalReviewStateKeys = new Set(
    Object.keys(state).filter((key) => key !== STATE_METADATA_KEY),
  );

  async function discoverAccount(account) {
    const logger = accountLogger(account, pollLogger);
    const scheduleGitHubOperation = scheduleGitHubOperationFor(account);
    if (!hasAiProcessingConsent(config)) {
      await recordFailure(
        {
          subject: logger.label,
          account: logger.label,
          note: 'AI-processing consent required',
        },
        logger.label,
        'AI-processing consent is missing for all selected repositories; ' +
          'rerun `openmergelens init`',
      );
      return { account, items: [] };
    }
    let auth;
    try {
      auth = await services.resolveGitHubAuth(account);
      const authenticatedUsername = await scheduleGitHubOperation(() =>
        services.currentUsername({ auth }),
      );
      if (authenticatedUsername.toLowerCase() !== account.username.toLowerCase()) {
        throw new Error(
          `configured username is ${account.username}, but the credential belongs to ${authenticatedUsername}`,
        );
      }
      logger.info(`authenticated for ${account.repositories.length} repository target(s)`);
    } catch (err) {
      await recordFailure(
        {
          subject: logger.label,
          account: logger.label,
          note: 'authentication failed',
        },
        logger.label,
        `account unavailable: ${err.message}`,
        err,
      );
      return { account, items: [] };
    }

    const items = [];
    const queued = new Set();
    for (const repo of account.repositories) {
      let candidates = [];
      let searchFailed = false;
      try {
        candidates = await timedStep(
          logger,
          `searching ${repo}`,
          () => scheduleGitHubOperation(() =>
            services.searchReviewRequestedPRs({
              username: account.username,
              repo,
              auth,
            }),
          ),
        );
      } catch (err) {
        await recordFailure(
          {
            subject: repo,
            account: logger.label,
            note: 'search failed',
          },
          logger.label,
          `search failed for ${repo}: ${err.message}`,
          err,
        );
        searchFailed = true;
      }

      const requestedCandidates = [];
      let searchTrustworthy = !searchFailed;
      if (!searchFailed) {
        if (!Array.isArray(candidates)) {
          await recordFailure(
            {
              subject: repo,
              account: logger.label,
              note: 'search candidates malformed',
            },
            logger.label,
            `search returned malformed candidates for ${repo}`,
          );
          searchFailed = true;
          searchTrustworthy = false;
        } else if (!hasTrustedSearchProvenance(
          candidates,
          services.isValidatedReviewRequestSearchResult,
        )) {
          await recordFailure(
            {
              subject: repo,
              account: logger.label,
              note: 'search completeness unproven',
            },
            logger.label,
            `search did not prove complete results for ${repo}`,
          );
          searchFailed = true;
          searchTrustworthy = false;
        } else {
          for (const candidate of candidates) {
            const checked = requestedCandidateForRepository(candidate, repo);
            if (!checked.candidate) {
              await recordFailure(
                {
                  subject: repo,
                  account: logger.label,
                  note: 'search candidate rejected',
                },
                logger.label,
                `rejected ${checked.reason} from search results for ${repo}`,
              );
              searchTrustworthy = false;
              continue;
            }
            requestedCandidates.push({
              ...checked.candidate,
              source: 'requested',
            });
          }
          if (!searchTrustworthy) requestedCandidates.length = 0;
        }
      }

      candidates = rotateCandidateGroup(requestedCandidates, {
        account,
        repo,
        source: 'requested',
        state,
      });
      if (candidates.length > 0) {
        const cursor = candidates[0].candidateCursor;
        candidateCursorPlans.set(cursor.key, cursor);
      }
      if (searchTrustworthy && candidates.length === 0) {
        logger.info(`no PRs awaiting review in ${repo}`);
      }
      for (const candidate of candidates) {
        const candidateKey = `${candidate.repo.toLowerCase()}#${candidate.number}`;
        if (queued.has(candidateKey)) continue;
        queued.add(candidateKey);
        items.push({ ...candidate, auth, scheduleGitHubOperation });
      }
    }
    return { account, auth, scheduleGitHubOperation, items };
  }

  // Keep each account's repositories ordered behind its own scheduler while
  // allowing unrelated accounts to make progress during another account's
  // rate-limit backoff. The helper preserves input order in its result.
  accountQueues.push(
    ...(await processWithConcurrency(
      accounts,
      MAX_CONCURRENT_ACCOUNT_DISCOVERIES,
      discoverAccount,
    )),
  );
  for (const queue of accountQueues) {
    if (!queue.auth || typeof queue.scheduleGitHubOperation !== 'function') continue;
    const reviewer = accountKey(queue.account);
    for (const repo of queue.account.repositories) {
      authenticatedReviewScopes.set(
        `${reviewer}::${repo.toLowerCase()}`,
        queue,
      );
    }
  }

  async function sweepHistoricalReviewState() {
    if (dryRun) return;

    const eligibleKeys = Object.keys(state)
      .filter((key) => {
        if (key === STATE_METADATA_KEY) return false;
        if (!historicalReviewStateKeys.has(key)) return false;
        const parsed = parsePrKey(key);
        if (!parsed?.reviewer) return false;
        return authenticatedScope(reviewScopeKey(key)) !== null;
      })
      .sort();
    if (eligibleKeys.length === 0) return;

    const afterKey = reviewStateGcAfterKey(state);
    let start = afterKey === null
      ? 0
      : eligibleKeys.findIndex((key) => key > afterKey);
    if (start < 0) start = 0;
    const rotatedKeys = [
      ...eligibleKeys.slice(start),
      ...eligibleKeys.slice(0, start),
    ];
    const remainingBudget = MAX_STATE_GC_CHECKS_PER_POLL -
      stateMaintenanceOperationsUsed;
    if (remainingBudget <= 0) return;
    const checkedKeys = rotatedKeys.slice(0, remainingBudget);
    const closedKeys = [];

    for (const key of checkedKeys) {
      const parsed = parsePrKey(key);
      const scope = authenticatedScope(reviewScopeKey(key));
      const logger = accountLogger(scope.account, pollLogger);
      let trackedPr;
      try {
        stateMaintenanceOperationsUsed += 1;
        trackedPr = await scope.scheduleGitHubOperation(() =>
          services.getPullRequestForStateGc({
            repo: parsed.repo,
            number: parsed.number,
            auth: scope.auth,
          }),
        );
      } catch (err) {
        await logger.warn(
          `historical state check failed for ${parsed.repo}#${parsed.number}: ${err.message}`,
          {
            event: 'state.gc.check_failed',
            fields: {
              repo: parsed.repo,
              number: parsed.number,
              scope: logger.label,
            },
            error: err,
          },
        );
        continue;
      }
      const metadataError = pullRequestMetadataError(trackedPr);
      if (metadataError) {
        await logger.warn(
          `historical state check returned malformed metadata for ` +
          `${parsed.repo}#${parsed.number}: ${metadataError}`,
          {
            event: 'state.gc.check_failed',
            fields: {
              repo: parsed.repo,
              number: parsed.number,
              scope: logger.label,
            },
          },
        );
        continue;
      }
      if (trackedPr.state === 'CLOSED' || trackedPr.state === 'MERGED') {
        closedKeys.push(key);
      }
    }

    // A cursor is needed only when the sweep cannot cover the full eligible
    // scope in this poll. Avoid rewriting small, fully checked state files
    // solely to remember a position that provides no fairness benefit.
    const cursorNeeded = checkedKeys.length < eligibleKeys.length;
    const nextAfterKey = checkedKeys.at(-1);
    const cursorChanged = cursorNeeded &&
      nextAfterKey !== reviewStateGcAfterKey(state);
    if (closedKeys.length === 0 && !cursorChanged) return;
    try {
      await persistStateBatch(() => {
        for (const key of closedKeys) delete state[key];
        if (cursorNeeded) {
          recordReviewStateGcAfterKey(state, nextAfterKey);
        }
      });
      if (closedKeys.length > 0) {
        pollLogger.info(
          `retired ${closedKeys.length} closed historical review state ` +
          `entr${closedKeys.length === 1 ? 'y' : 'ies'}`,
        );
      }
    } catch (err) {
      await recordFailure(
        {
          subject: 'review state',
          note: 'state GC persistence failed',
        },
        'review state GC',
        `historical review state cleanup failed: ${err.message}`,
        err,
      );
    }
  }

  const reviewQueue = roundRobinAccountQueues(accountQueues);
  if (reviewQueue.length === 0) {
    await sweepHistoricalReviewState();
    await stateWriteQueue;
    pollLogger.info('poll complete', { event: 'poll.completed', fields: { count: 0 } });
    return { failed, reviewed: 0, outcomes: [], failures };
  }

  const reviewBatchSize = resolveReviewBatchSize(config.reviewBatchSize);
  pollLogger.info(
    `processing ${reviewQueue.length} candidate PR(s) with global batch size ${reviewBatchSize}`,
    { event: 'poll.queue.started', fields: { count: reviewQueue.length } },
  );

  // This counts both active review attempts and reservations waiting for
  // review reconciliation. A reservation is released when GitHub confirms
  // that the review already exists, so no-op recovery cannot consume the
  // finite per-poll review budget while concurrent attempts remain bounded.
  let actionableReviewCapacityUsed = 0;
  let actionableReviewCapacityPending = 0;
  const actionableReviewCapacityWaiters = new Set();
  let safetyDeferredCount = 0;
  let candidateMetadataFetched = 0;
  let candidateMetadataDeferredCount = 0;

  function wakeActionableReviewCapacityWaiters() {
    const waiters = [...actionableReviewCapacityWaiters];
    actionableReviewCapacityWaiters.clear();
    for (const wake of waiters) wake();
  }

  async function reserveActionableReviewCapacity() {
    while (true) {
      if (actionableReviewCapacityUsed < MAX_REVIEWS_PER_POLL) {
        actionableReviewCapacityUsed += 1;
        actionableReviewCapacityPending += 1;
        let settled = false;
        const settle = (consume) => {
          if (settled) return;
          settled = true;
          actionableReviewCapacityPending -= 1;
          if (!consume) actionableReviewCapacityUsed -= 1;
          wakeActionableReviewCapacityWaiters();
        };
        return {
          commit: () => settle(true),
          release: () => settle(false),
        };
      }
      if (actionableReviewCapacityPending === 0) return null;
      await new Promise((resolve) => {
        actionableReviewCapacityWaiters.add(resolve);
      });
    }
  }

  async function reviewCandidate(candidate) {
    const releaseAdmission = await reviewAdmission.acquire();
    try {
      return await runReviewCandidate(candidate);
    } finally {
      releaseAdmission();
    }
  }

  async function runReviewCandidate({
    account,
    auth,
    repo,
    number,
    scheduleGitHubOperation,
    candidateCursor,
  }) {
    const logger = accountLogger(account, pollLogger);
    const baseEntry = {
      repo,
      number,
      account: logger.label,
      hostname: auth.hostname,
    };
    if (candidateMetadataFetched >= MAX_CANDIDATE_METADATA_PER_POLL) {
      candidateMetadataDeferredCount += 1;
      logger.info(
        `defer ${repo}#${number} (candidate metadata budget reached)`,
      );
      return null;
    }
    candidateMetadataFetched += 1;
    if (candidateCursor) {
      candidateCursorProgress.set(
        candidateCursor.key,
        Math.max(
          candidateCursorProgress.get(candidateCursor.key) ?? 0,
          candidateCursor.index + 1,
        ),
      );
    }
    let pr;
    try {
      pr = await timedStep(
        logger,
        `fetching ${repo}#${number} metadata`,
        () => scheduleGitHubOperation(() =>
          services.getPullRequest({ repo, number, auth }),
        ),
      );
    } catch (err) {
      return recordFailure(
        { ...baseEntry, note: 'metadata fetch failed' },
        logger.label,
        `PR view failed for ${repo}#${number}: ${err.message}`,
        err,
      );
    }
    const metadataError = pullRequestMetadataError(pr);
    if (metadataError) {
      return recordFailure(
        { ...baseEntry, note: 'metadata malformed' },
        logger.label,
        `PR view returned malformed metadata for ${repo}#${number}: ${metadataError}`,
      );
    }
    const key = prKey(repo, number, account);
    if (pr.state !== 'OPEN') {
      if (
        !dryRun &&
        (pr.state === 'CLOSED' || pr.state === 'MERGED') &&
        state[key] !== undefined
      ) {
        try {
          await retireTrackedState(key);
        } catch (err) {
          return recordFailure(
            { ...baseEntry, note: 'tracking cleanup failed' },
            logger.label,
            `state cleanup failed for ${repo}#${number}: ${err.message}`,
            err,
          );
        }
      }
      logger.info(`skip ${repo}#${number} (state: ${pr.state ?? 'unknown'})`);
      return null;
    }

    const hadPreviousReview = state[key] !== undefined;
    if (!needsReview(state, key, pr.headRefOid)) {
      logger.info(`skip ${repo}#${number} (already reviewed at ${pr.headRefOid})`);
      return null;
    }

    const actionableCapacityReservation =
      await reserveActionableReviewCapacity();
    if (actionableCapacityReservation === null) {
      safetyDeferredCount += 1;
      logger.info(
        `defer ${repo}#${number} (actionable review safety limit reached)`,
      );
      return null;
    }

    const prEntry = {
      ...baseEntry,
      title: pr.title,
      url: pr.url,
    };

    let reservation;
    let releaseStateReservation = async () => {};
    if (!dryRun) {
      try {
        reservation = {
          key,
          entry: {
            lastReviewedSha: pr.headRefOid,
            lastReviewedAt: new Date(services.now()).toISOString(),
            reviewMarkerVersion: 1,
          },
        };
        releaseStateReservation = await reserveReviewStateCapacity(reservation);
      } catch (err) {
        actionableCapacityReservation.release();
        return recordFailure(
          { ...prEntry, note: 'review state capacity reached' },
          logger.label,
          `cannot review ${repo}#${number}: ${err.message}`,
          err,
        );
      }
    }

    try {
    const reviewMarker = services.createReviewMarker({
      account,
      repo,
      number,
      commitId: pr.headRefOid,
    });
    let alreadyPosted;
    try {
      alreadyPosted = await scheduleGitHubOperation(() =>
        services.reviewAlreadyPosted({
          repo,
          number,
          commitId: pr.headRefOid,
          marker: reviewMarker,
          auth,
        }),
      );
    } catch (err) {
      return recordFailure(
        { ...prEntry, note: 'review reconciliation failed' },
        logger.label,
        `review reconciliation failed for ${repo}#${number}: ${err.message}`,
        err,
      );
    }
    if (alreadyPosted) {
      actionableCapacityReservation.release();
      if (dryRun) {
        logger.info(
          `dry run detected existing review for ${repo}#${number}; state unchanged`,
        );
        return {
          status: 'dry-run',
          ...prEntry,
          note: 'existing review detected; state not changed in dry run',
        };
      }
      try {
        await persistReview(reservation);
        logger.info(`reconciled existing review for ${repo}#${number}`);
        return { status: 'recovered', ...prEntry };
      } catch (err) {
        return recordFailure(
          { ...prEntry, note: 'tracking recovery failed' },
          logger.label,
          `review reconciliation state failed for ${repo}#${number}: ${err.message}`,
          err,
        );
      }
    }
    actionableCapacityReservation.commit();

    let diff;
    try {
      diff = await timedStep(
        logger,
        `fetching ${repo}#${number} diff`,
        () => scheduleGitHubOperation(() =>
          services.getPullRequestDiff({ repo, number, auth }),
        ),
      );
    } catch (err) {
      return recordFailure(
        { ...prEntry, note: 'diff fetch failed' },
        logger.label,
        `diff fetch failed for ${repo}#${number}: ${err.message}`,
        err,
      );
    }
    let template;
    let learnings;
    try {
      const promptPath = await services.ensureReviewPrompt(account.hostname, repo, {
        templatePath: defaultReviewPromptPath,
        dryRun,
      });
      [template, learnings] = await Promise.all([
        services.readPrompt(promptPath),
        services.readLearnings(account, repo, {
          hardenPermissions: !dryRun,
        }),
      ]);
    } catch (err) {
      return recordFailure(
        { ...prEntry, note: 'review files failed' },
        logger.label,
        `review files failed for ${repo}#${number}: ${err.message}`,
        err,
      );
    }

    let review;
    try {
      review = await timedStep(
        logger,
        `reviewing ${repo}#${number} (${config.reviewFocusCount} focused passes + synthesis; model: ${describeReviewerModel(config.model)})`,
        () => {
          const reviewerCommand = reviewerCommandForGitHubHost(
            config.reviewerCommand,
            auth.hostname,
          );
          return services.invokeMultiPassReview({
            reviewerCommand,
            model: config.model,
            template,
            learnings,
            pr,
            reviewFocusCount: config.reviewFocusCount,
            timeoutMs: config.reviewTimeoutMs,
            environment: buildReviewerEnvironment(
              reviewerCommand,
              authEnvironment(auth),
            ),
            githubAccess: {
              repo,
              number,
              headRefOid: pr.headRefOid,
              url: pr.url,
              environment: authEnvironment(auth),
              scheduleGitHubOperation,
            },
            onDiagnostic: (message) => logger.info(
              `reviewing ${repo}#${number}: ${message}`,
            ),
          });
        },
      );
    } catch (err) {
      return recordFailure(
        { ...prEntry, note: 'reviewer failed' },
        logger.label,
        `reviewer failed for ${repo}#${number}: ${err.message}`,
        err,
      );
    }

    let currentPr;
    try {
      currentPr = await timedStep(
        logger,
        `confirming ${repo}#${number} head commit`,
        () => scheduleGitHubOperation(() =>
          services.getPullRequest({ repo, number, auth }),
        ),
      );
    } catch (err) {
      return recordFailure(
        { ...prEntry, note: 'head verification failed' },
        logger.label,
        `head verification failed for ${repo}#${number}: ${err.message}`,
        err,
      );
    }
    const confirmationMetadataError = pullRequestMetadataError(currentPr);
    if (confirmationMetadataError) {
      return recordFailure(
        { ...prEntry, note: 'head verification failed' },
        logger.label,
        `head verification failed for ${repo}#${number}: ` +
        `malformed confirmation metadata: ${confirmationMetadataError}`,
      );
    }
    if (currentPr.state !== 'OPEN') {
      if (
        !dryRun &&
        (currentPr.state === 'CLOSED' || currentPr.state === 'MERGED') &&
        state[key] !== undefined
      ) {
        try {
          await retireTrackedState(key);
        } catch (err) {
          return recordFailure(
            { ...prEntry, note: 'tracking cleanup failed' },
            logger.label,
            `state cleanup failed for ${repo}#${number}: ${err.message}`,
            err,
          );
        }
      }
      logger.info(
        `skip ${repo}#${number} before posting (state: ${currentPr.state ?? 'unknown'})`,
      );
      return null;
    }
    if (currentPr.headRefOid !== pr.headRefOid) {
      logger.info(
        `head changed during review for ${repo}#${number}: ` +
        `${pr.headRefOid} -> ${currentPr.headRefOid}; ` +
        'deferring until the next poll',
      );
      return {
        status: 'deferred',
        ...prEntry,
        note: 'new commits during review; will retry next poll',
      };
    }

    let reviewRequestActive;
    try {
      reviewRequestActive = await scheduleGitHubOperation(() =>
        services.hasActiveReviewRequest({
          repo,
          number,
          username: account.username,
          auth,
        }),
      );
    } catch (err) {
      return recordFailure(
        { ...prEntry, note: 'review request verification failed' },
        logger.label,
        `review request verification failed for ${repo}#${number}: ${err.message}`,
        err,
      );
    }
    if (!reviewRequestActive) {
      logger.info(`skip ${repo}#${number} (review request was revoked)`);
      return null;
    }

    if (dryRun) {
      let prepared;
      try {
        prepared = services.prepareReview({
          commitId: pr.headRefOid,
          body: review.summary,
          comments: review.findings,
          diff,
          marker: reviewMarker,
          auth,
        });
      } catch (err) {
        return recordFailure(
          { ...prEntry, note: 'dry-run validation failed' },
          logger.label,
          `dry run failed for ${repo}#${number}: ${err.message}`,
          err,
        );
      }
      logger.info(`--- dry run result for ${repo}#${number} ---`);
      logger.output(review.summary);
      logger.info(
        `${prepared.anchorable.length} inline finding(s); ` +
        `${prepared.unanchorable.length} summary-only finding(s)`,
      );
      return {
        status: 'dry-run',
        ...prEntry,
        note: hadPreviousReview ? 'new commits' : undefined,
      };
    }

      try {
        await timedStep(
          logger,
          `posting ${repo}#${number} review`,
          () => services.postReview({
            repo,
            number,
            commitId: pr.headRefOid,
            body: review.summary,
            comments: review.findings,
            diff,
            marker: reviewMarker,
            auth,
            scheduleMutation: (
              operation,
              { mutation = true } = {},
            ) => scheduleGitHubOperation(() => {
              if (!mutation) return operation();

              const validateMutationBoundary = async () => {
                const mutationPr = await services.getPullRequest({ repo, number, auth });
                const mutationMetadataError = pullRequestMetadataError(mutationPr);
                if (mutationMetadataError) {
                  throw new Error(
                    `mutation boundary metadata is malformed: ${mutationMetadataError}`,
                  );
                }
                if (mutationPr.state === 'CLOSED' || mutationPr.state === 'MERGED') {
                  logger.info(
                    `skip ${repo}#${number} at mutation boundary ` +
                    `(state: ${mutationPr.state})`,
                  );
                  throw new ReviewMutationBoundaryError('closed');
                }
                if (mutationPr.state !== 'OPEN') {
                  throw new Error(
                    `mutation boundary returned unexpected state ${mutationPr.state}`,
                  );
                }
                if (mutationPr.headRefOid !== pr.headRefOid) {
                  logger.info(
                    `head changed at mutation boundary for ${repo}#${number}: ` +
                    `${pr.headRefOid} -> ${mutationPr.headRefOid}; ` +
                    'deferring until the next poll',
                  );
                  throw new ReviewMutationBoundaryError('stale');
                }
                const stillRequested = await services.hasActiveReviewRequest({
                  repo,
                  number,
                  username: account.username,
                  auth,
                });
                if (!stillRequested) {
                  logger.info(
                    `skip ${repo}#${number} at mutation boundary ` +
                    '(review request was revoked)',
                  );
                  throw new ReviewMutationBoundaryError('revoked');
                }
              };

              return reviewMutationCadence.run(operation, {
                beforeStart: validateMutationBoundary,
              });
            }),
          }),
        );
      } catch (err) {
        const boundaryReason = mutationBoundaryReason(err);
        if (boundaryReason === 'closed') {
          try {
            await retireTrackedState(key);
          } catch (cleanupError) {
            return recordFailure(
              { ...prEntry, note: 'tracking cleanup failed' },
              logger.label,
              `state cleanup failed for ${repo}#${number}: ${cleanupError.message}`,
              cleanupError,
            );
          }
          return null;
        }
        if (boundaryReason === 'revoked') return null;
        if (boundaryReason === 'stale') {
          return {
            status: 'deferred',
            ...prEntry,
            note: 'new commits during review; will retry next poll',
          };
        }
        return recordFailure(
          { ...prEntry, note: 'review post failed' },
          logger.label,
          `post failed for ${repo}#${number}: ${err.message}`,
          err,
        );
      }

      try {
        await persistReview(reservation);
        logger.info(`posted review for ${repo}#${number}`);
      } catch (err) {
        failed = true;
        const trackingFailure = {
          status: 'tracking-failed',
          ...prEntry,
          note: 'will reconcile',
        };
        failures.push(trackingFailure);
        await logger.error(
          `state failed after posting ${repo}#${number}: ${err.message}`,
          {
            event: 'poll.failure',
            fields: { ...prEntry, note: 'state failed after posting', scope: logger.label },
            error: err,
          },
        );
        return trackingFailure;
      }
      return {
        status: hadPreviousReview ? 're-reviewed' : 'reviewed',
        ...prEntry,
      };
    } finally {
      actionableCapacityReservation.commit();
      await releaseStateReservation();
    }
  }

  const results = [];
  for (let offset = 0; offset < reviewQueue.length; offset += reviewBatchSize) {
    const batchResults = await processInBatches(
      reviewQueue.slice(offset, offset + reviewBatchSize),
      reviewBatchSize,
      reviewCandidate,
    );
    results.push(...batchResults.filter(Boolean));
  }
  await persistReviewStateProofOrder();
  await sweepHistoricalReviewState();
  if (!dryRun) {
    for (const [cursorKey, progress] of candidateCursorProgress) {
      const plan = candidateCursorPlans.get(cursorKey);
      if (!plan || progress <= 0) continue;
      const nextOffset = (plan.start + progress) % plan.length;
      const currentOffset = candidateCursorFor(state, cursorKey) % plan.length;
      if (nextOffset === currentOffset) continue;
      try {
        await persistStateChange(STATE_METADATA_KEY, () => {
          recordCandidateCursor(state, cursorKey, nextOffset);
        });
      } catch (err) {
        await recordFailure(
          {
            subject: cursorKey,
            note: 'candidate cursor persistence failed',
          },
          'candidate scheduling',
          `candidate scheduling state failed for ${cursorKey}: ${err.message}`,
          err,
        );
      }
    }
  }
  await stateWriteQueue;
  if (safetyDeferredCount > 0) {
    failed = true;
    failures.push({
      status: 'failed',
      subject: 'review queue',
      note: `${safetyDeferredCount} candidate(s) deferred by safety limit`,
    });
    await pollLogger.error(
      `review queue reached the ${MAX_REVIEWS_PER_POLL}-review safety limit; ` +
      `deferred ${safetyDeferredCount} actionable candidate(s)`,
      {
        event: 'poll.failure',
        fields: {
          scope: 'safety',
          subject: 'review queue',
          count: safetyDeferredCount,
          reason: 'review safety limit',
        },
      },
    );
  }
  if (candidateMetadataDeferredCount > 0) {
    const note =
      `${candidateMetadataDeferredCount} candidate(s) deferred by metadata budget`;
    results.push({
      status: 'deferred',
      subject: 'review queue',
      note,
    });
    await pollLogger.info(
      `review queue reached the ${MAX_CANDIDATE_METADATA_PER_POLL}-candidate ` +
      `metadata budget; deferred ${candidateMetadataDeferredCount} candidate(s)`,
      {
        event: 'poll.deferred',
        fields: {
          scope: 'candidate metadata',
          subject: 'review queue',
          count: candidateMetadataDeferredCount,
          reason: 'candidate metadata budget',
        },
      },
    );
  }
  const outcomes = results.filter(
    (result) =>
      result &&
      result.status !== 'failed' &&
      result.status !== 'tracking-failed',
  );
  const reviewed = outcomes.filter(
    (result) => result.status !== 'deferred',
  ).length;

  pollLogger.info(`poll complete${failed ? ' with failures' : ''}`, {
    event: 'poll.completed',
    fields: {
      count: outcomes.length,
      status: failed ? 'failed' : 'ok',
    },
  });
  return {
    failed,
    reviewed,
    outcomes,
    failures,
  };
}

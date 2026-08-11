import { readFile } from 'node:fs/promises';
import {
  createReviewMarker,
  currentUsername,
  getPullRequest,
  getPullRequestDiff,
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
  MAX_REVIEWS_PER_POLL,
} from './security-limits.mjs';
import {
  loadState,
  migrateLegacyStateForReviewer,
  needsReview,
  normalizeState,
  parsePrKey,
  prKey,
  candidateCursorFor,
  recordCandidateCursor,
  recordReview,
  saveState,
  STATE_METADATA_KEY,
} from './state.mjs';

const MAX_CONCURRENT_ACCOUNT_DISCOVERIES = 5;
// Admit a small cushion of candidates beyond the review cap so unchanged or
// closed candidates do not consume the whole poll's chance to find actionable
// work. Candidates beyond this window stay queued for the next poll. The
// window bounds candidate metadata reads; review-time head confirmations are
// still required for admitted reviews and are bounded by MAX_REVIEWS_PER_POLL.
export const MAX_CANDIDATE_METADATA_PER_POLL = MAX_REVIEWS_PER_POLL + 5;

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

function hasTrustedSearchCompletenessProof(candidates) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(candidates, 'complete');
  } catch {
    return false;
  }
  return descriptor !== undefined &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.value === true &&
    descriptor.enumerable === false &&
    descriptor.writable === false &&
    descriptor.configurable === false;
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
    getPullRequest,
    getPullRequestDiff,
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
    // Keep the injected loader's existing one-argument contract while making
    // the built-in loader aware of dry-run's no-metadata-write guarantee.
    loadState: (statePath) => loadState(statePath, { hardenPermissions: !dryRun }),
    saveState,
    ...dependencies,
  };
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
  const state = normalizeState(await services.loadState(stateFile));
  let failed = false;
  const accountQueues = [];
  const failures = [];
  const candidateCursorProgress = new Map();
  const candidateCursorPlans = new Map();

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
    const snapshot = { ...state };
    const migrated = migrateLegacyStateForReviewer(state, accounts[0]);
    if (migrated && !dryRun) {
      try {
        await services.saveState(stateFile, state);
      } catch (err) {
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, snapshot);
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
        } else if (!hasTrustedSearchCompletenessProof(candidates)) {
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
    return { account, items };
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

  const reviewQueue = roundRobinAccountQueues(accountQueues);
  if (reviewQueue.length === 0) {
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
  let safetyDeferredCount = 0;
  let candidateMetadataFetched = 0;
  let candidateMetadataDeferredCount = 0;
  let stateWriteQueue = Promise.resolve();
  function persistStateChange(key, change) {
    const write = stateWriteQueue.then(async () => {
      const previous = state[key];
      change();
      try {
        await services.saveState(stateFile, state);
      } catch (err) {
        if (previous === undefined) delete state[key];
        else state[key] = previous;
        throw err;
      }
    });
    stateWriteQueue = write.catch(() => {});
    return write;
  }

  function persistReview(key, sha) {
    return persistStateChange(key, () => {
      recordReview(state, key, sha, new Date().toISOString());
    });
  }

  function retireTrackedState(key) {
    if (state[key] === undefined) return Promise.resolve();
    return persistStateChange(key, () => {
      delete state[key];
    });
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

    if (actionableReviewCapacityUsed >= MAX_REVIEWS_PER_POLL) {
      safetyDeferredCount += 1;
      logger.info(
        `defer ${repo}#${number} (actionable review safety limit reached)`,
      );
      return null;
    }
    actionableReviewCapacityUsed += 1;

    const prEntry = {
      ...baseEntry,
      title: pr.title,
      url: pr.url,
    };

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
      actionableReviewCapacityUsed -= 1;
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
        await persistReview(key, pr.headRefOid);
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
          scheduleMutation: (operation) => scheduleGitHubOperation(() => {
            const validateMutationBoundary = async () => {
              const mutationPr = await services.getPullRequest({ repo, number, auth });
              if (mutationPr.state !== 'OPEN') {
                logger.info(
                  `skip ${repo}#${number} at mutation boundary ` +
                  `(state: ${mutationPr.state ?? 'unknown'})`,
                );
                throw new ReviewMutationBoundaryError('closed');
              }
              if (mutationPr.headRefOid !== pr.headRefOid) {
                logger.info(
                  `head changed at mutation boundary for ${repo}#${number}: ` +
                  `${pr.headRefOid} -> ${mutationPr.headRefOid}; ` +
                  'deferring until the next poll',
                );
                throw new ReviewMutationBoundaryError('stale');
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
      if (boundaryReason === 'closed') return null;
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
      await persistReview(key, pr.headRefOid);
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

import { constants as fsConstants } from 'node:fs';
import {
  lstat as fsLstat,
  mkdir,
  open,
  readdir as fsReaddir,
  realpath as fsRealpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { accountKey, normalizeRepository } from './config.mjs';
import {
  enforcePrivateModeHandle,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';
import {
  MAX_REVIEW_STATE_ENTRIES,
  MAX_REVIEW_STATE_FUTURE_SKEW_MS,
  MAX_REVIEW_STATE_GC_CURSOR_CHARS,
  MAX_REVIEW_STATE_KEY_CHARS,
  MAX_REVIEW_STATE_SHA_CHARS,
  MAX_REVIEW_STATE_TIMESTAMP_CHARS,
  MAX_REVIEW_STATE_TEMPORARIES,
  MAX_STATE_FILE_BYTES,
  REVIEW_STATE_RETENTION_DAYS,
} from './security-limits.mjs';

// The review state is primarily a flat map of scoped OWNER/REPO#N entries.
// This reserved metadata slot stores bounded scheduler cursors without
// pretending that a cursor is a reviewed commit.
export const STATE_METADATA_KEY = '__openmergelens';
const STATE_METADATA_VERSION = 1;
const MAX_CANDIDATE_CURSOR_ENTRIES = 10_000;
const MAX_CANDIDATE_CURSOR_KEY_CHARS = 512;
const PROOF_METADATA_MIGRATION_NEEDED = Symbol('proofMetadataMigrationNeeded');
const ENTRY_LIMIT_MIGRATION_NEEDED = Symbol('entryLimitMigrationNeeded');
// Pre-cap releases could write larger state files. Permit one bounded read for
// the explicit migration path, while keeping ordinary reads at the public cap.
export const MAX_LEGACY_STATE_FILE_BYTES = MAX_STATE_FILE_BYTES * 2;
export const REVIEW_STATE_COMMIT_INDETERMINATE = 'ESTATECOMMITINDETERMINATE';
const CANONICAL_POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const REVIEW_STATE_TEMPORARY_NAME = /^.+\.tmp-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WINDOWS_RETENTION_LOCK_RETRY_MS = 5;
const WINDOWS_RETENTION_LOCK_RETRY_LIMIT = 1_000;
const WINDOWS_RETENTION_LOCK_NAME = '.openmergelens-retention.lock';
const WINDOWS_RETENTION_LOCK_BLOCKED = 'blocked\n';
const WINDOWS_RETENTION_CAPACITY_ERROR = 'ERETENTIONCAPACITY';
const WINDOWS_RETENTION_LOCK_UNSAFE_ERROR = 'ERETENTIONLOCKUNSAFE';
const WINDOWS_RETENTION_LOCK_UNSAFE_PROBE_CODES = new Set(['ELOOP', 'ENOTDIR']);
const WINDOWS_RETENTION_LOCK_BLOCKED_BYTES = Buffer.from(
  WINDOWS_RETENTION_LOCK_BLOCKED,
  'utf8',
);
const windowsRetentionQueues = new Map();
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const BIGINT_STATS_OPTIONS = Object.freeze({ bigint: true });
const REVIEW_ENTRY_FIELDS = new Set([
  'lastReviewedSha',
  'lastReviewedAt',
  'reviewMarkerVersion',
]);
const STATE_METADATA_FIELDS = new Set([
  'version',
  'candidateCursors',
  'reviewStateGcAfterKey',
  // Transitional read-only fields written by the unreleased proof-cursor
  // implementation. Normalization migrates their position into entry order
  // and never emits them, so version-1 state remains predecessor-readable.
  'reviewStateProofAfterScope',
  'reviewStateProofAfterKeys',
]);

export class ReviewStateCommitIndeterminateError extends Error {
  constructor(stateFile, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `review state namespace commit for ${stateFile} succeeded, but its ` +
      `result could not be verified: ${detail}`,
      { cause },
    );
    this.name = 'ReviewStateCommitIndeterminateError';
    this.code = REVIEW_STATE_COMMIT_INDETERMINATE;
    this.commitStatus = 'indeterminate';
    this.committed = true;
  }
}

export function reviewerKey({ hostname, username }) {
  return accountKey({ hostname, username });
}

export function parsePrKey(key) {
  if (
    typeof key !== 'string' ||
    !key ||
    key.length > MAX_REVIEW_STATE_KEY_CHARS
  ) return null;

  const scopedParts = key.split('::');
  if (scopedParts.length > 2) return null;
  const reviewerText = scopedParts.length === 2 ? scopedParts[0] : null;
  const pullRequest = scopedParts.length === 2 ? scopedParts[1] : scopedParts[0];
  const numberSeparator = pullRequest.lastIndexOf('#');
  if (numberSeparator <= 0) return null;

  const repoText = pullRequest.slice(0, numberSeparator);
  const numberText = pullRequest.slice(numberSeparator + 1);
  if (!CANONICAL_POSITIVE_DECIMAL.test(numberText)) return null;
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  let repo;
  try {
    repo = normalizeRepository(repoText).toLowerCase();
  } catch {
    return null;
  }
  let reviewer = null;
  if (reviewerText !== null) {
    const separator = reviewerText.indexOf('@');
    if (separator <= 0 || separator !== reviewerText.lastIndexOf('@')) return null;
    try {
      reviewer = accountKey({
        hostname: reviewerText.slice(0, separator),
        username: reviewerText.slice(separator + 1),
      });
    } catch {
      return null;
    }
  }

  const canonicalKey = `${reviewer === null ? '' : `${reviewer}::`}${repo}#${numberText}`;
  // Historical keys may differ from the canonical spelling only by ASCII
  // identifier casing. Numeric aliases, padding, and other ambiguous forms
  // are rejected instead of being silently adopted.
  if (key.toLowerCase() !== canonicalKey) return null;

  return { reviewer, repo, number, numberText, canonicalKey };
}

export function normalizePrKey(key) {
  const parsed = parsePrKey(key);
  if (!parsed) return key;
  return parsed.canonicalKey;
}

export function prKey(repo, number, reviewer) {
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error('review state pull request number is invalid');
  }
  const pullRequest = `${normalizeRepository(repo).toLowerCase()}#${number}`;
  return reviewer ? `${reviewerKey(reviewer)}::${pullRequest}` : pullRequest;
}

export function reviewScopeKey(key) {
  const parsed = parsePrKey(key);
  if (!parsed?.reviewer) return null;
  return `${parsed.reviewer}::${parsed.repo}`;
}

// State written before account scoping used unscoped OWNER/REPO#N keys. An
// unscoped entry can be adopted only when the caller has identified one
// unambiguous reviewer account. Never replace an existing scoped entry: it is
// the stronger account-specific record.
export function migrateLegacyStateForReviewer(state, reviewer) {
  let changed = false;

  for (const [key, entry] of Object.entries(state)) {
    const parsed = parsePrKey(key);
    if (!parsed || parsed.reviewer !== null) continue;

    const scopedKey = prKey(parsed.repo, parsed.number, reviewer);
    if (!Object.prototype.hasOwnProperty.call(state, scopedKey)) {
      state[scopedKey] = entry;
    }
    delete state[key];
    changed = true;
  }

  return changed;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateState(
  state,
  stateFile,
  { nowMs = Date.now(), enforceEntryLimit = true } = {},
) {
  if (!isPlainObject(state)) {
    throw new Error(`Invalid review state in ${stateFile}: expected a JSON object`);
  }
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid review state in ${stateFile}: validation clock is invalid`);
  }

  let reviewEntryCount = 0;
  for (const [key, entry] of Object.entries(state)) {
    if (key === STATE_METADATA_KEY) {
      validateStateMetadata(entry, stateFile);
      continue;
    }
    reviewEntryCount += 1;
    if (enforceEntryLimit && reviewEntryCount > MAX_REVIEW_STATE_ENTRIES) {
      throw new Error(
        `Invalid review state in ${stateFile}: too many review entries`,
      );
    }
    const parsedKey = parsePrKey(key);
    const unknownField = isPlainObject(entry)
      ? Object.keys(entry).find((field) => !REVIEW_ENTRY_FIELDS.has(field))
      : undefined;
    if (
      !parsedKey ||
      !isPlainObject(entry) ||
      unknownField !== undefined ||
      typeof entry.lastReviewedSha !== 'string' ||
      !entry.lastReviewedSha ||
      entry.lastReviewedSha.length > MAX_REVIEW_STATE_SHA_CHARS ||
      typeof entry.lastReviewedAt !== 'string' ||
      entry.lastReviewedAt.length > MAX_REVIEW_STATE_TIMESTAMP_CHARS ||
      !isCanonicalReviewTimestamp(entry.lastReviewedAt, nowMs) ||
      (
        entry.reviewMarkerVersion !== undefined &&
        entry.reviewMarkerVersion !== 1
      )
    ) {
      throw new Error(
        `Invalid review state entry "${key}" in ${stateFile}: ` +
          'expected a canonical key, bounded record fields, and a non-future canonical timestamp',
      );
    }
  }

  return state;
}

function isCanonicalReviewTimestamp(value, nowMs) {
  if (!value) return false;
  try {
    const parsed = Date.parse(value);
    return new Date(parsed).toISOString() === value &&
      parsed <= nowMs + MAX_REVIEW_STATE_FUTURE_SKEW_MS;
  } catch {
    return false;
  }
}

function validateStateMetadata(metadata, stateFile) {
  const unknownField = isPlainObject(metadata)
    ? Object.keys(metadata).find((field) => !STATE_METADATA_FIELDS.has(field))
    : undefined;
  if (
    !isPlainObject(metadata) ||
    unknownField !== undefined ||
    metadata.version !== STATE_METADATA_VERSION ||
    !isPlainObject(metadata.candidateCursors)
  ) {
    throw new Error(
      `Invalid review state metadata in ${stateFile}: expected version ${STATE_METADATA_VERSION} and candidateCursors`,
    );
  }

  const cursorEntries = Object.entries(metadata.candidateCursors);
  if (cursorEntries.length > MAX_CANDIDATE_CURSOR_ENTRIES) {
    throw new Error(
      `Invalid review state metadata in ${stateFile}: too many candidate cursors`,
    );
  }
  for (const [key, offset] of cursorEntries) {
    if (
      !key ||
      key.length > MAX_CANDIDATE_CURSOR_KEY_CHARS ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new Error(
        `Invalid review state metadata in ${stateFile}: candidate cursor is invalid`,
      );
    }
  }
  if (
    metadata.reviewStateGcAfterKey !== undefined &&
    (
      typeof metadata.reviewStateGcAfterKey !== 'string' ||
      !metadata.reviewStateGcAfterKey ||
      metadata.reviewStateGcAfterKey.length > MAX_REVIEW_STATE_GC_CURSOR_CHARS
    )
  ) {
    throw new Error(
      `Invalid review state metadata in ${stateFile}: review-state GC cursor is invalid`,
    );
  }
  if (
    metadata.reviewStateProofAfterScope !== undefined &&
    !isCanonicalReviewScope(metadata.reviewStateProofAfterScope)
  ) {
    throw new Error(
      `Invalid review state metadata in ${stateFile}: review-state proof scope cursor is invalid`,
    );
  }
  if (metadata.reviewStateProofAfterKeys !== undefined) {
    if (!isPlainObject(metadata.reviewStateProofAfterKeys)) {
      throw new Error(
        `Invalid review state metadata in ${stateFile}: review-state proof cursors are invalid`,
      );
    }
    const proofCursorEntries = Object.entries(metadata.reviewStateProofAfterKeys);
    if (proofCursorEntries.length > MAX_CANDIDATE_CURSOR_ENTRIES) {
      throw new Error(
        `Invalid review state metadata in ${stateFile}: too many review-state proof cursors`,
      );
    }
    for (const [scope, key] of proofCursorEntries) {
      if (
        !scope ||
        scope.length > MAX_REVIEW_STATE_GC_CURSOR_CHARS ||
        typeof key !== 'string' ||
        !key ||
        key.length > MAX_REVIEW_STATE_GC_CURSOR_CHARS ||
        !isCanonicalReviewScope(scope) ||
        reviewScopeKey(key) !== scope
      ) {
        throw new Error(
          `Invalid review state metadata in ${stateFile}: review-state proof cursor is invalid`,
        );
      }
    }
  }
}

export function reviewStateNeedsProofMetadataMigration(state) {
  const metadata = state?.[STATE_METADATA_KEY];
  return state?.[PROOF_METADATA_MIGRATION_NEEDED] === true ||
    Object.prototype.hasOwnProperty.call(
      isPlainObject(metadata) ? metadata : {},
      'reviewStateProofAfterScope',
    ) ||
    Object.prototype.hasOwnProperty.call(
      isPlainObject(metadata) ? metadata : {},
      'reviewStateProofAfterKeys',
    );
}

export function reviewStateNeedsEntryLimitMigration(state) {
  return state?.[ENTRY_LIMIT_MIGRATION_NEEDED] === true;
}

function isCanonicalReviewScope(scope) {
  return typeof scope === 'string' &&
    !!scope &&
    scope.length <= MAX_REVIEW_STATE_GC_CURSOR_CHARS &&
    reviewScopeKey(`${scope}#1`) === scope;
}

function cloneStateMetadata(metadata) {
  if (!isPlainObject(metadata) || !isPlainObject(metadata.candidateCursors)) {
    return metadata;
  }
  const clone = {
    version: metadata.version,
    candidateCursors: Object.fromEntries(
      Object.entries(metadata.candidateCursors),
    ),
  };
  if (metadata.reviewStateGcAfterKey !== undefined) {
    clone.reviewStateGcAfterKey = metadata.reviewStateGcAfterKey;
  }
  return clone;
}

function reorderReviewStateEntries(state, orderedKeys) {
  const entries = new Map(orderedKeys.map((candidate) => [candidate, state[candidate]]));
  const metadata = state[STATE_METADATA_KEY];
  for (const candidate of Object.keys(state)) delete state[candidate];
  for (const candidate of orderedKeys) {
    Object.defineProperty(state, candidate, {
      configurable: true,
      enumerable: true,
      value: entries.get(candidate),
      writable: true,
    });
  }
  if (metadata !== undefined) {
    Object.defineProperty(state, STATE_METADATA_KEY, {
      configurable: true,
      enumerable: true,
      value: metadata,
      writable: true,
    });
  }
}

// An over-cap legacy file cannot safely grow cursor metadata. Preserve
// migration progress by moving the bounded attempted window to the end of the
// existing entry order without adding, removing, or changing a record.
export function recordReviewStateMigrationWindow(state, attemptedKeys) {
  const attempted = new Set(attemptedKeys);
  const entryKeys = Object.keys(state).filter((key) => key !== STATE_METADATA_KEY);
  const attemptedInState = entryKeys.filter((key) => attempted.has(key));
  if (attemptedInState.length === 0) return false;
  reorderReviewStateEntries(state, [
    ...entryKeys.filter((key) => !attempted.has(key)),
    ...attemptedInState,
  ]);
  return true;
}

function reorderReviewStateProofQueue(state, scope, key) {
  const entryKeys = Object.keys(state).filter((candidate) =>
    candidate !== STATE_METADATA_KEY,
  );
  const selectedScopeKeys = entryKeys.filter((candidate) =>
    reviewScopeKey(candidate) === scope,
  );
  if (!selectedScopeKeys.includes(key)) return;

  reorderReviewStateEntries(state, [
    ...entryKeys.filter((candidate) => reviewScopeKey(candidate) !== scope),
    ...selectedScopeKeys.filter((candidate) => candidate !== key),
    key,
  ]);
}

function rotateAfter(values, cursor) {
  if (typeof cursor !== 'string' || values.length === 0) return values;
  let start = values.findIndex((value) => value > cursor);
  if (start < 0) start = 0;
  return [...values.slice(start), ...values.slice(0, start)];
}

function migrateReviewStateProofQueue(state, metadata) {
  const scopedKeys = new Map();
  const unscopedKeys = [];
  for (const key of Object.keys(state)) {
    if (key === STATE_METADATA_KEY) continue;
    const scope = reviewScopeKey(key);
    if (!scope) {
      unscopedKeys.push(key);
      continue;
    }
    let keys = scopedKeys.get(scope);
    if (!keys) {
      keys = [];
      scopedKeys.set(scope, keys);
    }
    keys.push(key);
  }

  const orderedScopes = rotateAfter(
    [...scopedKeys.keys()].sort(),
    metadata.reviewStateProofAfterScope,
  );
  const proofKeys = metadata.reviewStateProofAfterKeys ?? {};
  const orderedKeys = [...unscopedKeys];
  for (const scope of orderedScopes) {
    const keys = scopedKeys.get(scope).sort();
    for (const key of rotateAfter(keys, proofKeys[scope])) {
      orderedKeys.push(key);
    }
  }
  reorderReviewStateEntries(state, orderedKeys);
}

function canonicalizeState(state) {
  const normalized = {};
  const sourceKeys = new Map();
  for (const [key, entry] of Object.entries(state)) {
    if (key === STATE_METADATA_KEY) continue;
    const normalizedKey = normalizePrKey(key);
    const previousKey = sourceKeys.get(normalizedKey);
    if (previousKey !== undefined && !shouldPreferStateEntry(key, previousKey)) {
      continue;
    }
    sourceKeys.set(normalizedKey, key);
    Object.defineProperty(normalized, normalizedKey, {
      configurable: true,
      enumerable: true,
      value: entry,
      writable: true,
    });
  }
  const metadata = state[STATE_METADATA_KEY];
  if (
    metadata?.reviewStateProofAfterScope !== undefined ||
    metadata?.reviewStateProofAfterKeys !== undefined
  ) {
    migrateReviewStateProofQueue(normalized, metadata);
  }
  if (Object.prototype.hasOwnProperty.call(state, STATE_METADATA_KEY)) {
    Object.defineProperty(normalized, STATE_METADATA_KEY, {
      configurable: true,
      enumerable: true,
      value: cloneStateMetadata(state[STATE_METADATA_KEY]),
      writable: true,
    });
  }
  return normalized;
}

export function normalizeState(
  state,
  {
    stateFile = 'review state',
    nowMs = Date.now(),
    enforceEntryLimit = true,
  } = {},
) {
  return canonicalizeState(validateState(state, stateFile, {
    nowMs,
    enforceEntryLimit,
  }));
}

function shouldPreferStateEntry(candidateKey, currentKey) {
  // Exact canonical spellings win; aliases use code-unit order so the
  // surviving entry does not depend on JSON property insertion order.
  const candidateIsCanonical = normalizePrKey(candidateKey) === candidateKey;
  const currentIsCanonical = normalizePrKey(currentKey) === currentKey;
  if (candidateIsCanonical !== currentIsCanonical) return candidateIsCanonical;
  return candidateKey < currentKey;
}

export async function loadState(
  stateFile,
  {
    platform = process.platform,
    realpath = fsRealpath,
    lstat = fsLstat,
    hardenPermissions = true,
    allowEntryLimitMigration = false,
    hardenHandle = enforcePrivateModeHandle,
  } = {},
) {
  const parentPath = path.dirname(stateFile);
  let parentHandle;
  let handle;
  try {
    parentHandle = await open(parentPath, fsConstants.O_RDONLY | NO_FOLLOW);
    const parentIdentity = await verifyPrivateParent(
      parentPath,
      parentHandle,
      'before reading state',
      { platform, realpath, lstat },
    );
    let pathStats;
    try {
      pathStats = await lstat(stateFile, BIGINT_STATS_OPTIONS);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // A missing target is the only absent-path case that represents an
      // ordinary empty state. Rebind the already-verified parent before
      // accepting it; an ancestor/parent replacement must fail closed.
      await verifyParentIdentity(parentPath, parentIdentity, 'while checking missing state', {
        platform,
        realpath,
        lstat,
      });
      return {};
    }
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
      throw new Error('review state target must be a regular non-symbolic-link file');
    }
    handle = await open(stateFile, fsConstants.O_RDONLY | NO_FOLLOW);
    const handleStats = await handle.stat(BIGINT_STATS_OPTIONS);
    assertUserOwnedFileStats(handleStats, 'review state file', { platform });
    if (!sameFileIdentity(handleStats, pathStats, {
      platform,
      // Node has no descriptor-relative state-file operations. On Windows a
      // file index is scoped to its volume, so an ino-only handle/path match
      // cannot bind the pathname to the held descriptor. Require the volume
      // component and fail closed when the runtime cannot prove it.
      requireVolumeMatch: platform === 'win32',
    })) {
      throw new Error('review state file identity changed before reading');
    }
    if (!samePathIdentity(pathStats, pathStats, { platform })) {
      throw new Error('review state file identity changed before reading');
    }
    await verifyParentIdentity(parentPath, parentIdentity, 'while opening state', {
      platform,
      realpath,
      lstat,
    });
    if (hardenPermissions) {
      // Harden the object represented by the verified descriptor, including
      // malformed files that will subsequently fail parsing. Never chmod a
      // pathname that could have been replaced after validation.
      await hardenHandle(handle, PRIVATE_FILE_MODE, { platform });
    }
    let raw;
    const readLimit = allowEntryLimitMigration
      ? MAX_LEGACY_STATE_FILE_BYTES
      : MAX_STATE_FILE_BYTES;
    const buffer = Buffer.allocUnsafe(readLimit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > readLimit) {
      throw new Error(
        `Invalid review state in ${stateFile}: file exceeds ${readLimit} bytes`,
      );
    }
    await verifyParentIdentity(parentPath, parentIdentity, 'while reading state', {
      platform,
      realpath,
      lstat,
    });
    await verifyPathIdentity(
      stateFile,
      pathStats,
      handleStats,
      'while reading state',
      { platform, lstat },
    );
    raw = buffer.subarray(0, bytesRead).toString('utf8');
    const parsedState = JSON.parse(raw);
    const proofMetadataMigrationNeeded =
      reviewStateNeedsProofMetadataMigration(parsedState);
    const { normalizedState: state, serializedBytes } = serializeState(parsedState, {
      stateFile,
      enforceEntryLimit: !allowEntryLimitMigration,
      enforceByteLimit: !allowEntryLimitMigration,
    });
    const entryLimitMigrationNeeded =
      reviewStateEntryCount(state) > MAX_REVIEW_STATE_ENTRIES ||
      serializedBytes > MAX_STATE_FILE_BYTES ||
      Buffer.byteLength(raw, 'utf8') > MAX_STATE_FILE_BYTES;
    if (proofMetadataMigrationNeeded) {
      Object.defineProperty(state, PROOF_METADATA_MIGRATION_NEEDED, {
        value: true,
      });
    }
    if (entryLimitMigrationNeeded) {
      Object.defineProperty(state, ENTRY_LIMIT_MIGRATION_NEEDED, {
        value: true,
      });
    }
    return state;
  } catch (err) {
    throw err;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (parentHandle) await parentHandle.close().catch(() => {});
  }
}

export function sameFileIdentity(
  left,
  right,
  {
    platform = process.platform,
    label = 'review state object',
    requireVolumeMatch = false,
  } = {},
) {
  const unsupported = () => {
    if (platform !== 'win32') return false;
    throw new Error(
      `${label} identity is unsupported on this Windows filesystem: ` +
        'fs.Stats bigint file indexes are unavailable or mismatched',
    );
  };

  if (left.isDirectory() !== right.isDirectory()) {
    unsupported();
    return false;
  }
  // Windows Node can report the volume/device identifier differently for a
  // handle and its path. An exact bigint file index is therefore the stable
  // binding for that pair. Numeric Stats values are accepted only through the
  // complete safe volume/file tuple. Timestamps and mode bits are mutable
  // metadata and cannot establish object identity. On POSIX the exact
  // (device, inode) tuple is required.
  if (platform === 'win32') {
    // The Windows handle/path pair may expose different volume identifiers,
    // but an exact bigint file index is still a stable object identity across
    // those two observations. Numeric Stats values are a hosted-runtime
    // fallback only: validate and compare the complete safe volume/file
    // tuple. Path-to-path callers separately compare the same tuple with
    // samePathIdentity.
    const hasValidBigintIdentity = [left, right].every((stats) =>
      typeof stats.dev === 'bigint' && stats.dev > 0n &&
      typeof stats.ino === 'bigint' && stats.ino > 0n,
    );
    if (hasValidBigintIdentity) {
      if (left.ino !== right.ino) {
        unsupported();
        return false;
      }
      if (requireVolumeMatch && !samePathIdentity(left, right, { platform, label })) {
        unsupported();
        return false;
      }
      return true;
    }

    const hasValidNumericIdentity = [left, right].every((stats) =>
      Number.isFinite(stats.dev) &&
      Number.isSafeInteger(stats.dev) &&
      stats.dev > 0 &&
      Number.isFinite(stats.ino) &&
      Number.isSafeInteger(stats.ino) &&
      stats.ino > 0,
    );
    if (
      !hasValidNumericIdentity ||
      left.dev !== right.dev ||
      left.ino !== right.ino
    ) {
      unsupported();
      return false;
    }
    return true;
  }

  const hasValidDeviceIdentity = [left, right].every((stats) =>
    typeof stats.dev === 'bigint' && stats.dev > 0n &&
    typeof stats.ino === 'bigint' && stats.ino > 0n,
  );
  if (!hasValidDeviceIdentity) return false;
  return left.dev === right.dev && left.ino === right.ino;
}

// Windows handle and path stats can expose different `dev` values even when
// they refer to the same object. Path-to-path checks still need the stable
// volume identity, however, so capture and compare it independently of the
// handle/path inode binding. Timestamps and mode bits are mutable metadata and
// are deliberately excluded from both checks.
export function samePathIdentity(
  left,
  right,
  { platform = process.platform, label = 'review state path' } = {},
) {
  if (left.isDirectory() !== right.isDirectory()) return false;
  const hasValidBigintPathIdentity = [left, right].every((stats) =>
    typeof stats.dev === 'bigint' && stats.dev > 0n &&
    typeof stats.ino === 'bigint' && stats.ino > 0n,
  );
  const hasValidNumericPathIdentity = platform === 'win32' &&
    [left, right].every((stats) =>
      Number.isFinite(stats.dev) &&
      Number.isSafeInteger(stats.dev) &&
      stats.dev > 0 &&
      Number.isFinite(stats.ino) &&
      Number.isSafeInteger(stats.ino) &&
      stats.ino > 0,
    );
  if (!hasValidBigintPathIdentity && !hasValidNumericPathIdentity) {
    if (platform === 'win32') {
      throw new Error(
        `${label} identity is unsupported on this Windows filesystem: ` +
          'fs.Stats bigint volume/file identities are unavailable',
      );
    }
    return false;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPrivateParentStats(stats, { platform = process.platform } = {}) {
  if (!stats.isDirectory()) {
    throw new Error('review state parent must be a directory');
  }
  if (
    platform !== 'win32' &&
    (
      stats.uid !== BigInt(process.getuid()) ||
      (stats.mode & 0o022n) !== 0n
    )
  ) {
    throw new Error(
      'review state parent directory must be user-owned and not group/other-writable',
    );
  }
}

function assertUserOwnedFileStats(
  stats,
  label,
  { platform = process.platform } = {},
) {
  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (
    platform !== 'win32' &&
    stats.uid !== BigInt(process.getuid())
  ) {
    throw new Error(`${label} must be user-owned`);
  }
}

export async function flushStateDirectoryHandle(
  handle,
  {
    platform = process.platform,
    syncHandle = (targetHandle) => targetHandle.sync(),
  } = {},
) {
  try {
    await syncHandle(handle);
  } catch (err) {
    if (
      platform === 'win32' &&
      ['EINVAL', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(err.code)
    ) {
      throw new Error(
        `directory fsync is unsupported on this Windows filesystem: ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }
}

function normalizeWindowsPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  return path.win32
    .normalize(path.win32.resolve(filePath))
    .replace(/[\\/]+$/u, '')
    .toLowerCase();
}

async function verifyPrivateParentPath(
  parentPath,
  phase,
  {
    platform = process.platform,
    realpath = fsRealpath,
    expectedCanonicalPath,
  } = {},
) {
  if (platform !== 'win32') return undefined;
  const resolvedPath = await realpath(parentPath);
  const canonicalPath = normalizeWindowsPath(resolvedPath);
  if (canonicalPath === null || (
    expectedCanonicalPath !== undefined &&
    canonicalPath !== expectedCanonicalPath
  )) {
    throw new Error(`review state parent directory realpath changed ${phase}`);
  }
  // Bind subsequent checks to the canonical path returned by the first
  // lookup.  Windows realpath may expand an 8.3 alias in an ancestor, so the
  // canonical value (rather than the lexical input) is the stable identity.
  return canonicalPath;
}

async function assertNoWindowsReparseAncestors(
  parentPath,
  phase,
  { platform = process.platform, lstat = fsLstat } = {},
) {
  // Tests may inject the Windows platform while using POSIX temporary paths;
  // those paths cannot contain Windows reparse points and need no walk.
  // A non-Windows test can exercise this Windows-only walk with an injected
  // lstat seam. The default POSIX lstat must not be given Win32-formatted
  // paths, while production Windows always performs the walk.
  if (
    platform !== 'win32' ||
    (process.platform !== 'win32' && lstat === fsLstat) ||
    !path.win32.isAbsolute(parentPath)
  ) return;
  let current = path.win32.normalize(parentPath);
  const root = path.win32.parse(current).root;
  while (current && current !== root) {
    const stats = await lstat(current, BIGINT_STATS_OPTIONS);
    if (stats.isSymbolicLink()) {
      throw new Error(`review state parent directory realpath changed ${phase}`);
    }
    const next = path.win32.dirname(current);
    if (next === current) break;
    current = next;
  }
}

async function verifyPrivateParent(
  parentPath,
  parentHandle,
  phase,
  { platform = process.platform, realpath = fsRealpath, lstat = fsLstat } = {},
) {
  const [handleStats, pathStats] = await Promise.all([
    parentHandle.stat(BIGINT_STATS_OPTIONS),
    lstat(parentPath, BIGINT_STATS_OPTIONS),
  ]);
  const canonicalPath = await verifyPrivateParentPath(parentPath, phase, {
    platform,
    realpath,
  });
  if (platform === 'win32') {
    await assertNoWindowsReparseAncestors(parentPath, phase, { platform, lstat });
  }
  assertPrivateParentStats(handleStats, { platform });
  if (
    !pathStats.isDirectory() ||
    pathStats.isSymbolicLink() ||
    !sameFileIdentity(handleStats, pathStats, {
      platform,
      requireVolumeMatch: platform === 'win32',
    }) ||
    !samePathIdentity(pathStats, pathStats, { platform })
  ) {
    throw new Error(`review state parent directory identity changed ${phase}`);
  }
  return { handleStats, pathStats, canonicalPath };
}

async function verifyParentIdentity(
  parentPath,
  expectedIdentity,
  phase,
  { platform = process.platform, realpath = fsRealpath, lstat = fsLstat } = {},
) {
  await verifyPrivateParentPath(parentPath, phase, {
    platform,
    realpath,
    expectedCanonicalPath: expectedIdentity.canonicalPath,
  });
  if (platform === 'win32') {
    await assertNoWindowsReparseAncestors(parentPath, phase, { platform, lstat });
  }
  const currentStats = await lstat(parentPath, BIGINT_STATS_OPTIONS);
  if (
    !currentStats.isDirectory() ||
    !samePathIdentity(expectedIdentity.pathStats, currentStats, { platform }) ||
    !sameFileIdentity(expectedIdentity.handleStats, currentStats, {
      platform,
      requireVolumeMatch: platform === 'win32',
    })
  ) {
    throw new Error(`review state parent directory identity changed ${phase}`);
  }
}

async function verifyPathIdentity(
  targetPath,
  expectedPathStats,
  expectedHandleStats,
  phase,
  { platform = process.platform, lstat = fsLstat } = {},
) {
  const currentStats = await lstat(targetPath, BIGINT_STATS_OPTIONS);
  if (
    !currentStats.isFile() ||
    currentStats.isSymbolicLink() ||
    !samePathIdentity(expectedPathStats, currentStats, { platform }) ||
    !sameFileIdentity(expectedHandleStats, currentStats, {
      platform,
      requireVolumeMatch: platform === 'win32',
    })
  ) {
    throw new Error(`review state file identity changed ${phase}`);
  }
}

export function serializeState(
  state,
  {
    stateFile = 'review state',
    nowMs = Date.now(),
    enforceEntryLimit = true,
    enforceByteLimit = true,
  } = {},
) {
  const normalizedState = normalizeState(state, {
    stateFile,
    nowMs,
    enforceEntryLimit,
  });
  const serialized = JSON.stringify(normalizedState, null, 2) + '\n';
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  if (enforceByteLimit && serializedBytes > MAX_STATE_FILE_BYTES) {
    throw new Error(
      `Invalid review state in ${stateFile}: serialized state exceeds ${MAX_STATE_FILE_BYTES} bytes`,
    );
  }
  return { normalizedState, serialized, serializedBytes };
}

// Failed Windows replacements are intentionally retained because Node does
// not expose a descriptor-relative unlink primitive. Count every generated
// temporary artifact in the verified parent and fail closed once the bounded
// retention budget is exhausted. Do not inspect-and-delete: a directory entry
// may have been substituted after enumeration, and deleting an unverified
// pathname could remove attacker-owned content.
async function assertWindowsTemporaryCapacity(
  parentPath,
  {
    platform = process.platform,
    readdir = fsReaddir,
  } = {},
) {
  if (platform !== 'win32') return;

  let names;
  try {
    names = await readdir(parentPath);
  } catch (err) {
    throw new Error(
      `review state temporary retention cannot be verified: ${err.message}`,
      { cause: err },
    );
  }
  if (!Array.isArray(names)) {
    throw new Error(
      'review state temporary retention cannot be verified: parent listing is invalid',
    );
  }
  const retainedCount = names.reduce(
    (count, name) => count + (
      typeof name === 'string' && REVIEW_STATE_TEMPORARY_NAME.test(name)
        ? 1
        : 0
    ),
    0,
  );
  if (retainedCount >= MAX_REVIEW_STATE_TEMPORARIES) {
    const error = new Error(
      `review state temporary retention limit reached (${MAX_REVIEW_STATE_TEMPORARIES})`,
    );
    error.code = WINDOWS_RETENTION_CAPACITY_ERROR;
    throw error;
  }
}

// The retention count and temporary creation must be one serialized
// operation. A process-local queue covers concurrent saves in this process;
// the O_EXCL marker extends that serialization to other OpenMergeLens
// processes using the same state directory. We deliberately never scavenge
// retained temporary files: if the marker cannot be released safely, the
// operation fails closed and leaves the marker for operator inspection.
function withWindowsRetentionQueue(parentPath, operation) {
  const previous = windowsRetentionQueues.get(parentPath) || Promise.resolve();
  let releaseQueue;
  const current = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  windowsRetentionQueues.set(parentPath, current);
  return previous
    .catch(() => {})
    .then(operation)
    .finally(() => {
      releaseQueue();
      if (windowsRetentionQueues.get(parentPath) === current) {
        windowsRetentionQueues.delete(parentPath);
      }
    });
}

async function acquireWindowsRetentionLock(
  lockPath,
  {
    openFile = open,
    platform = process.platform,
  } = {},
) {
  if (platform !== 'win32') return null;
  for (let attempt = 0; attempt < WINDOWS_RETENTION_LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      const handle = await openFile(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
        PRIVATE_FILE_MODE,
      );
      // Keep the active marker empty. The open descriptor is the lock, and
      // leaving its offset at zero lets the same handle become the replacement
      // temporary file after the pathname rename without a lock-prefix leak.
      return handle;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // A retained blocked marker is deliberately never removed or replaced.
      // Read it through a no-follow descriptor so repeated post-cap attempts
      // fail quickly without creating another evidence pathname. Any probe
      // ambiguity remains a normal bounded lock wait and therefore fails
      // closed after the same retry budget.
      let probe;
      try {
        probe = await openFile(
          lockPath,
          fsConstants.O_RDONLY | NO_FOLLOW,
        );
        const opened = await probe.stat(BIGINT_STATS_OPTIONS);
        if (!opened.isFile() || opened.isSymbolicLink()) {
          const unsafe = new Error(
            'review state temporary retention lock must be a regular file',
          );
          unsafe.code = WINDOWS_RETENTION_LOCK_UNSAFE_ERROR;
          throw unsafe;
        }
        if (opened.size > BigInt(WINDOWS_RETENTION_LOCK_BLOCKED_BYTES.length)) {
          const unsafe = new Error(
            'review state temporary retention lock is oversized',
          );
          unsafe.code = WINDOWS_RETENTION_LOCK_UNSAFE_ERROR;
          throw unsafe;
        }
        const contents = Buffer.alloc(WINDOWS_RETENTION_LOCK_BLOCKED_BYTES.length + 1);
        let bytesRead = 0;
        while (bytesRead < contents.length) {
          const read = await probe.read(
            contents,
            bytesRead,
            contents.length - bytesRead,
            bytesRead,
          );
          bytesRead += read.bytesRead;
          if (read.bytesRead === 0) break;
        }
        if (bytesRead > WINDOWS_RETENTION_LOCK_BLOCKED_BYTES.length) {
          const unsafe = new Error(
            'review state temporary retention lock is oversized',
          );
          unsafe.code = WINDOWS_RETENTION_LOCK_UNSAFE_ERROR;
          throw unsafe;
        }
        if (
          bytesRead === WINDOWS_RETENTION_LOCK_BLOCKED_BYTES.length &&
          contents.subarray(0, bytesRead).equals(WINDOWS_RETENTION_LOCK_BLOCKED_BYTES)
        ) {
          const blocked = new Error(
            `review state temporary retention limit reached (${MAX_REVIEW_STATE_TEMPORARIES})`,
          );
          blocked.code = WINDOWS_RETENTION_CAPACITY_ERROR;
          throw blocked;
        }
      } catch (probeError) {
        if (
          probeError.code === WINDOWS_RETENTION_CAPACITY_ERROR ||
          probeError.code === WINDOWS_RETENTION_LOCK_UNSAFE_ERROR ||
          WINDOWS_RETENTION_LOCK_UNSAFE_PROBE_CODES.has(probeError.code)
        ) {
          if (WINDOWS_RETENTION_LOCK_UNSAFE_PROBE_CODES.has(probeError.code)) {
            const unsafe = new Error(
              'review state temporary retention lock is not a safe regular file',
              { cause: probeError },
            );
            unsafe.code = WINDOWS_RETENTION_LOCK_UNSAFE_ERROR;
            throw unsafe;
          }
          throw probeError;
        }
        // The owner may be between O_EXCL creation and its state write, or a
        // platform-specific read may be unavailable. Continue the bounded
        // acquisition wait rather than treating untrusted bytes as proof.
      } finally {
        await probe?.close().catch(() => {});
      }
      await new Promise((resolve) => {
        setTimeout(resolve, WINDOWS_RETENTION_LOCK_RETRY_MS);
      });
    }
  }
  throw new Error('review state temporary retention lock is unavailable');
}

async function openWindowsTemporary(
  parentPath,
  temporaryPath,
  {
    stateFile,
    platform = process.platform,
    readdir = fsReaddir,
    openFile = open,
    lstat = fsLstat,
    reserveRename = rename,
    parentIdentity,
    realpath = fsRealpath,
  } = {},
) {
  if (platform !== 'win32') {
    return openFile(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      PRIVATE_FILE_MODE,
    );
  }
  // The retained-temporary cap is parent-wide, so both the lock and its
  // bounded blocked marker must be independent of the state filename.
  const lockPath = path.join(parentPath, WINDOWS_RETENTION_LOCK_NAME);
  return withWindowsRetentionQueue(parentPath, async () => {
    const lockHandle = await acquireWindowsRetentionLock(lockPath, {
      openFile,
      platform,
    });
    try {
      await assertWindowsTemporaryCapacity(parentPath, { platform, readdir });
      // Move the atomically-created lock marker to the generated temporary
      // name. The open handle follows the inode, so this both releases the
      // cross-process lock and creates the retained-cap reservation without
      // any pathname deletion.
      await verifyParentIdentity(parentPath, parentIdentity, 'before temporary reservation', {
        platform,
        realpath,
        lstat,
      });
      await reserveRename(lockPath, temporaryPath);
      return lockHandle;
    } catch (error) {
      if (error?.code === WINDOWS_RETENTION_CAPACITY_ERROR) {
        // Keep one deterministic parent-scoped marker for a positively
        // confirmed capacity exhaustion. Other failures must release the
        // reservation so a transient listing, identity, or rename error does
        // not permanently poison subsequent saves.
        try {
          await lockHandle.truncate(0);
          const writeResult = await lockHandle.write(
            WINDOWS_RETENTION_LOCK_BLOCKED,
            0,
            'utf8',
          );
          if (
            !writeResult ||
            writeResult.bytesWritten !== WINDOWS_RETENTION_LOCK_BLOCKED_BYTES.length
          ) {
            throw new Error(
              'review state temporary retention lock sentinel write was short',
            );
          }
          await lockHandle.sync();
        } catch (markerError) {
          // Do not leave an indistinguishable empty marker after a failed
          // sentinel write. Move the held inode to the generated temporary
          // pathname so the parent-scoped lock name is released without an
          // unsafe pathname unlink. The retained inode remains operator
          // evidence and is bounded by the same temporary-artifact policy.
          error.markerError = markerError;
          try {
            await reserveRename(lockPath, temporaryPath);
          } catch (cleanupError) {
            error.cleanupError = cleanupError;
          }
        }
      } else {
        // A pathname unlink would reintroduce the replacement race this
        // reservation lock is designed to prevent. Move the held inode to
        // the already-generated temporary pathname instead. This preserves
        // operator evidence and releases the parent lock without deleting an
        // unverified pathname; a later save can recover while the cap still
        // bounds the retained artifact.
        try {
          await reserveRename(lockPath, temporaryPath);
        } catch (cleanupError) {
          error.cleanupError = cleanupError;
        }
      }
      await lockHandle.close().catch(() => {});
      throw error;
    }
  });
}

export async function saveState(
  stateFile,
  state,
  {
    platform = process.platform,
    realpath = fsRealpath,
    lstat = fsLstat,
    readdir = fsReaddir,
    openFile = open,
    reserveRename = rename,
    allowEntryLimitMigration = false,
    hardenHandle = enforcePrivateModeHandle,
    flushHandle = (handle) => handle.sync(),
    flushParentHandle = flushStateDirectoryHandle,
    onPostCommitError = async () => {},
    beforeRename = async () => {},
    afterIdentityCheck = async () => {},
    beforeCommitRename = async () => {},
    afterCommitRename = async () => {},
    commitRename = rename,
    removeTemporary = rm,
  } = {},
) {
  const serializedState = serializeState(state, {
    stateFile,
    enforceEntryLimit: !allowEntryLimitMigration,
    enforceByteLimit: !allowEntryLimitMigration,
  });
  let {
    normalizedState,
    serialized,
    serializedBytes,
  } = serializedState;
  if (
    allowEntryLimitMigration &&
    serializedBytes > MAX_STATE_FILE_BYTES
  ) {
    // Pretty printing can expand a compact predecessor state beyond the
    // bounded 32 MiB migration envelope even though an order-only progress
    // save has not grown its data. Preserve the canonical object and entry
    // order using compact JSON until repair reaches the ordinary limits.
    serialized = JSON.stringify(normalizedState) + '\n';
    serializedBytes = Buffer.byteLength(serialized, 'utf8');
  }
  if (
    allowEntryLimitMigration &&
    serializedBytes > MAX_LEGACY_STATE_FILE_BYTES
  ) {
    throw new Error(
      `Invalid review state in ${stateFile}: legacy migration state exceeds ` +
      `${MAX_LEGACY_STATE_FILE_BYTES} bytes`,
    );
  }
  // stateFile may be an absolute, user-selected path outside
  // OPENMERGELENS_HOME. Create a missing parent privately, but never chmod an
  // existing parent directory that OpenMergeLens does not own.
  const parentPath = path.dirname(stateFile);
  await mkdir(parentPath, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  const temporaryPath = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
  let namespaceCommitted = false;
  let handle;
  let parentHandle;
  let parentIdentity;
  let temporaryPathStats;
  let temporaryCreated = false;
  let failure;
  let cleanupFailure;
  try {
    parentHandle = await open(parentPath, fsConstants.O_RDONLY | NO_FOLLOW);
    parentIdentity = await verifyPrivateParent(
      parentPath,
      parentHandle,
      'before commit',
      { platform, realpath, lstat },
    );
    handle = await openWindowsTemporary(parentPath, temporaryPath, {
      platform,
      stateFile,
      readdir,
      openFile,
      lstat,
      reserveRename,
      parentIdentity,
      realpath,
    });
    temporaryCreated = true;
    await handle.writeFile(serialized, { encoding: 'utf8' });
    // Make permission hardening part of the pre-commit phase. Rename is the
    // final fallible operation, so a reported failure can never coexist with
    // an already-replaced target file.
    await hardenHandle(handle, PRIVATE_FILE_MODE, { platform });
    // Flush the verified replacement bytes before the namespace commit. A
    // process or system failure can therefore leave the old target or the
    // fully written replacement, never a rename of merely buffered content.
    await flushHandle(handle);
    await beforeRename(temporaryPath);
    let [handleStats, pathStats] = await Promise.all([
      handle.stat(BIGINT_STATS_OPTIONS),
      lstat(temporaryPath, BIGINT_STATS_OPTIONS),
    ]);
    assertUserOwnedFileStats(handleStats, 'review state temporary file', { platform });
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      !sameFileIdentity(handleStats, pathStats, {
        platform,
        requireVolumeMatch: platform === 'win32',
      }) ||
      !samePathIdentity(pathStats, pathStats, { platform })
    ) {
      throw new Error('review state temporary file identity changed before commit');
    }
    temporaryPathStats = pathStats;
    await verifyParentIdentity(parentPath, parentIdentity, 'before commit', {
      platform,
      realpath,
      lstat,
    });
    try {
      const targetStats = await lstat(stateFile, BIGINT_STATS_OPTIONS);
      if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
        throw new Error('existing review state target is not a regular non-symbolic-link file');
      }
      assertUserOwnedFileStats(targetStats, 'existing review state target', {
        platform,
      });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // This hook models replacement after the first identity check. Revalidate
    // both the held file and its private parent immediately before the single
    // atomic replacement operation.
    await afterIdentityCheck(temporaryPath);
    [handleStats, pathStats] = await Promise.all([
      handle.stat(BIGINT_STATS_OPTIONS),
      lstat(temporaryPath, BIGINT_STATS_OPTIONS),
    ]);
    assertUserOwnedFileStats(handleStats, 'review state temporary file', { platform });
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      !sameFileIdentity(handleStats, pathStats, {
        platform,
        requireVolumeMatch: platform === 'win32',
      }) ||
      !samePathIdentity(temporaryPathStats, pathStats, { platform })
    ) {
      throw new Error('review state temporary file identity changed before atomic commit');
    }
    await verifyParentIdentity(parentPath, parentIdentity, 'before atomic commit', {
      platform,
      realpath,
      lstat,
    });

    // Node does not expose descriptor-relative renameat(). Model the final
    // check/rename boundary explicitly, then treat the pathname rename as
    // provisional until the resulting parent and target are rebound to the
    // held descriptors below.
    await beforeCommitRename(temporaryPath, stateFile);
    await commitRename(temporaryPath, stateFile);
    // rename is the namespace commit. Any later error is not a rollback: the
    // old pathname contents may already be irreversibly replaced.
    namespaceCommitted = true;
    await afterCommitRename(temporaryPath, stateFile);
    const [committedStats] = await Promise.all([
      lstat(stateFile, BIGINT_STATS_OPTIONS),
      verifyParentIdentity(parentPath, parentIdentity, 'after atomic commit', {
        platform,
        realpath,
        lstat,
      }),
    ]);
    if (
      !committedStats.isFile() ||
      committedStats.isSymbolicLink() ||
      !sameFileIdentity(handleStats, committedStats, {
        platform,
        requireVolumeMatch: platform === 'win32',
      }) ||
      !samePathIdentity(temporaryPathStats, committedStats, { platform })
    ) {
      throw new Error(
        'review state commit could not be bound to the verified parent and temporary file',
      );
    }
    try {
      // The rename is already committed. Flushing the held directory makes
      // that namespace update crash-durable where directory fsync is
      // supported. A failure here cannot be reported as rollback because the
      // target and caller-visible state have already changed.
      await flushParentHandle(parentHandle, { platform });
    } catch (err) {
      try {
        await onPostCommitError(err);
      } catch {
        // Warning/reporting failures cannot turn a committed save into an
        // apparent rollback.
      }
      return {
        committed: true,
        directorySynced: false,
        postCommitError: err,
      };
    }
  } catch (err) {
    failure = namespaceCommitted
      ? new ReviewStateCommitIndeterminateError(stateFile, err)
      : err;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (parentHandle) await parentHandle.close().catch(() => {});
    if (!namespaceCommitted && temporaryCreated) {
      // Node does not expose unlinkat()/DeleteFile-by-handle. A pathname rm
      // after descriptor checks is therefore not safe on Windows: the parent
      // namespace can be substituted after verification. Keep the generated
      // file and report cleanup failure until a platform-safe primitive is
      // available instead of invoking the pathname callback.
      if (platform === 'win32') {
        cleanupFailure = new Error(
          'temporary file retained because safe cleanup failed: ' +
          'descriptor-relative cleanup is unavailable on Windows',
        );
      } else {
        try {
          // If the pathname no longer names the verified parent, do not unlink
          // through it: the replacement directory may contain attacker-owned
          // content at the generated basename. The error explicitly surfaces
          // that the private original directory may retain the temp object.
          await verifyParentIdentity(
            parentPath,
            parentIdentity,
            'before temporary cleanup',
            { platform, realpath, lstat },
          );
          await removeTemporary(temporaryPath, { force: true });
        } catch (err) {
          cleanupFailure = new Error(
            `temporary file retained because safe cleanup failed: ${err.message}`,
            { cause: err },
          );
        }
      }
    }
  }
  if (failure && cleanupFailure) {
    throw new AggregateError(
      [failure, cleanupFailure],
      `${failure.message}; review state temporary cleanup also failed: ${cleanupFailure.message}`,
    );
  }
  if (failure) throw failure;
  return { committed: true, directorySynced: true };
}

export function needsReview(state, key, currentSha) {
  const entry = state[normalizePrKey(key)];
  if (!entry) return true;
  return entry.lastReviewedSha !== currentSha;
}

export function recordReview(
  state,
  key,
  sha,
  reviewedAt,
  { reviewMarkerVersion = 1 } = {},
) {
  const entry = {
    lastReviewedSha: sha,
    lastReviewedAt: reviewedAt,
  };
  if (reviewMarkerVersion !== undefined) {
    entry.reviewMarkerVersion = reviewMarkerVersion;
  }
  state[normalizePrKey(key)] = entry;
}

export function reviewStateEntryCount(state) {
  return Object.keys(state).reduce(
    (count, key) => count + (key === STATE_METADATA_KEY ? 0 : 1),
    0,
  );
}

export function expireReviewState(state, nowMs = Date.now()) {
  if (!Number.isFinite(nowMs)) {
    throw new Error('review state retention clock is invalid');
  }
  const cutoff = nowMs - REVIEW_STATE_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  const expiredKeys = [];
  for (const [key, entry] of Object.entries(state)) {
    if (key === STATE_METADATA_KEY) continue;
    if (Date.parse(entry.lastReviewedAt) <= cutoff) {
      delete state[key];
      expiredKeys.push(key);
    }
  }
  return expiredKeys;
}

export function candidateCursorFor(state, cursorKey) {
  const offset = state?.[STATE_METADATA_KEY]?.candidateCursors?.[cursorKey];
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

export function recordCandidateCursor(state, cursorKey, offset) {
  if (
    typeof cursorKey !== 'string' ||
    !cursorKey ||
    cursorKey.length > MAX_CANDIDATE_CURSOR_KEY_CHARS ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new Error('candidate cursor is invalid');
  }

  const current = state[STATE_METADATA_KEY];
  const cursors = Object.fromEntries(
    isPlainObject(current?.candidateCursors)
      ? Object.entries(current.candidateCursors)
      : [],
  );
  if (!Object.prototype.hasOwnProperty.call(cursors, cursorKey) &&
      Object.keys(cursors).length >= MAX_CANDIDATE_CURSOR_ENTRIES) {
    throw new Error('candidate cursor limit reached');
  }
  Object.defineProperty(cursors, cursorKey, {
    configurable: true,
    enumerable: true,
    value: offset,
    writable: true,
  });
  state[STATE_METADATA_KEY] = {
    version: STATE_METADATA_VERSION,
    candidateCursors: cursors,
  };
  if (current?.reviewStateGcAfterKey !== undefined) {
    state[STATE_METADATA_KEY].reviewStateGcAfterKey =
      current.reviewStateGcAfterKey;
  }
}

export function reviewStateGcAfterKey(state) {
  const key = state?.[STATE_METADATA_KEY]?.reviewStateGcAfterKey;
  if (typeof key === 'string') return key;
  for (const [candidate, entry] of Object.entries(state ?? {})) {
    if (candidate === STATE_METADATA_KEY || !isPlainObject(entry)) continue;
    const fields = Object.keys(entry);
    if (fields[0] === 'lastReviewedAt' && fields[1] === 'lastReviewedSha') {
      return candidate;
    }
  }
  return null;
}

export function recordReviewStateGcAfterKey(state, key) {
  if (
    typeof key !== 'string' ||
    !key ||
    key.length > MAX_REVIEW_STATE_GC_CURSOR_CHARS
  ) {
    throw new Error('review-state GC cursor is invalid');
  }
  const current = state[STATE_METADATA_KEY];
  state[STATE_METADATA_KEY] = {
    version: STATE_METADATA_VERSION,
    candidateCursors: Object.fromEntries(
      isPlainObject(current?.candidateCursors)
        ? Object.entries(current.candidateCursors)
        : [],
    ),
    reviewStateGcAfterKey: key,
  };
}

function orderedReviewStateEntry(entry, gcPosition) {
  const ordered = gcPosition
    ? {
        lastReviewedAt: entry.lastReviewedAt,
        lastReviewedSha: entry.lastReviewedSha,
      }
    : {
        lastReviewedSha: entry.lastReviewedSha,
        lastReviewedAt: entry.lastReviewedAt,
      };
  if (entry.reviewMarkerVersion !== undefined) {
    ordered.reviewMarkerVersion = entry.reviewMarkerVersion;
  }
  return ordered;
}

export function recordReviewStateGcPosition(state, key) {
  if (
    typeof key !== 'string' ||
    !key ||
    key.length > MAX_REVIEW_STATE_GC_CURSOR_CHARS ||
    key === STATE_METADATA_KEY ||
    !Object.prototype.hasOwnProperty.call(state, key)
  ) {
    throw new Error('review-state GC position is invalid');
  }

  for (const [candidate, entry] of Object.entries(state)) {
    if (candidate === STATE_METADATA_KEY) continue;
    const fields = Object.keys(entry);
    if (fields[0] === 'lastReviewedAt' && fields[1] === 'lastReviewedSha') {
      state[candidate] = orderedReviewStateEntry(entry, false);
    }
  }
  state[key] = orderedReviewStateEntry(state[key], true);

  const metadata = state[STATE_METADATA_KEY];
  if (metadata?.reviewStateGcAfterKey !== undefined) {
    const nextMetadata = { ...metadata };
    delete nextMetadata.reviewStateGcAfterKey;
    state[STATE_METADATA_KEY] = nextMetadata;
  }
}

export function rotateReviewStateProofQueue(state, scope, key) {
  if (
    !isCanonicalReviewScope(scope) ||
    typeof key !== 'string' ||
    !key ||
    key.length > MAX_REVIEW_STATE_GC_CURSOR_CHARS ||
    reviewScopeKey(key) !== scope
  ) {
    throw new Error('review-state proof queue position is invalid');
  }
  if (!Object.prototype.hasOwnProperty.call(state, key)) {
    throw new Error('review-state proof queue key is missing');
  }
  reorderReviewStateProofQueue(state, scope, key);
}

export function recordReviewStateProofOrder(state, orderedKeys) {
  if (!Array.isArray(orderedKeys)) {
    throw new Error('review-state proof queue order is invalid');
  }
  const existingKeys = Object.keys(state).filter((key) => key !== STATE_METADATA_KEY);
  const existing = new Set(existingKeys);
  const seen = new Set();
  const nextOrder = [];
  for (const key of orderedKeys) {
    if (typeof key !== 'string' || seen.has(key)) {
      throw new Error('review-state proof queue order is invalid');
    }
    seen.add(key);
    if (existing.has(key)) nextOrder.push(key);
  }
  for (const key of existingKeys) {
    if (!seen.has(key)) nextOrder.push(key);
  }
  reorderReviewStateEntries(state, nextOrder);
}

import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { accountKey, normalizeRepository } from './config.mjs';
import {
  enforcePrivateMode,
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
const CANONICAL_POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const REVIEW_ENTRY_FIELDS = new Set([
  'lastReviewedSha',
  'lastReviewedAt',
  'reviewMarkerVersion',
]);
const STATE_METADATA_FIELDS = new Set([
  'version',
  'candidateCursors',
  'reviewStateGcAfterKey',
]);

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

export async function loadState(stateFile, { hardenPermissions = true } = {}) {
  try {
    const handle = await open(stateFile, 'r');
    let raw;
    try {
      const buffer = Buffer.allocUnsafe(MAX_STATE_FILE_BYTES + 1);
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
      if (bytesRead > MAX_STATE_FILE_BYTES) {
        throw new Error(
          `Invalid review state in ${stateFile}: file exceeds ${MAX_STATE_FILE_BYTES} bytes`,
        );
      }
      raw = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    const { normalizedState: state } = serializeState(JSON.parse(raw), {
      stateFile,
    });
    if (hardenPermissions) {
      await enforcePrivateMode(stateFile, PRIVATE_FILE_MODE);
    }
    return state;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
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

export async function saveState(stateFile, state) {
  const { serialized } = serializeState(state, { stateFile });
  // stateFile may be an absolute, user-selected path outside
  // OPENMERGELENS_HOME. Create a missing parent privately, but never chmod an
  // existing parent directory that OpenMergeLens does not own.
  await mkdir(path.dirname(stateFile), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  const temporaryPath = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporaryPath,
      serialized,
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: PRIVATE_FILE_MODE,
      },
    );
    await rename(temporaryPath, stateFile);
    await enforcePrivateMode(stateFile, PRIVATE_FILE_MODE);
  } finally {
    await rm(temporaryPath, { force: true });
  }
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
  return typeof key === 'string' ? key : null;
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

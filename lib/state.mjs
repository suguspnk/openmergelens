import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { accountKey } from './config.mjs';
import {
  enforcePrivateMode,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';
import {
  MAX_REVIEW_STATE_ENTRIES,
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

export function reviewerKey({ hostname, username }) {
  return accountKey({ hostname, username });
}

export function parsePrKey(key) {
  if (typeof key !== 'string') return null;

  const scopeSeparator = key.lastIndexOf('::');
  const reviewer = scopeSeparator >= 0 ? key.slice(0, scopeSeparator) : null;
  const pullRequest = scopeSeparator >= 0 ? key.slice(scopeSeparator + 2) : key;
  const numberSeparator = pullRequest.lastIndexOf('#');
  if (numberSeparator <= 0) return null;

  const repo = pullRequest.slice(0, numberSeparator);
  const numberText = pullRequest.slice(numberSeparator + 1);
  const number = Number(numberText);
  if (!repo || !Number.isSafeInteger(number) || number <= 0) return null;

  return { reviewer, repo, number, numberText };
}

export function normalizePrKey(key) {
  const parsed = parsePrKey(key);
  if (!parsed) return key;

  const scope = parsed.reviewer === null ? '' : `${parsed.reviewer.toLowerCase()}::`;
  return `${scope}${parsed.repo.toLowerCase()}#${parsed.number}`;
}

export function prKey(repo, number, reviewer) {
  const pullRequest = `${repo.toLowerCase()}#${number}`;
  return reviewer ? `${reviewerKey(reviewer)}::${pullRequest}` : pullRequest;
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

function validateState(state, stateFile) {
  if (!isPlainObject(state)) {
    throw new Error(`Invalid review state in ${stateFile}: expected a JSON object`);
  }

  let reviewEntryCount = 0;
  for (const [key, entry] of Object.entries(state)) {
    if (key === STATE_METADATA_KEY) {
      validateStateMetadata(entry, stateFile);
      continue;
    }
    reviewEntryCount += 1;
    if (reviewEntryCount > MAX_REVIEW_STATE_ENTRIES) {
      throw new Error(
        `Invalid review state in ${stateFile}: too many review entries`,
      );
    }
    if (
      !key ||
      key.length > MAX_REVIEW_STATE_KEY_CHARS ||
      !isPlainObject(entry) ||
      typeof entry.lastReviewedSha !== 'string' ||
      !entry.lastReviewedSha ||
      entry.lastReviewedSha.length > MAX_REVIEW_STATE_SHA_CHARS ||
      typeof entry.lastReviewedAt !== 'string' ||
      entry.lastReviewedAt.length > MAX_REVIEW_STATE_TIMESTAMP_CHARS ||
      !isCanonicalReviewTimestamp(entry.lastReviewedAt)
    ) {
      throw new Error(
        `Invalid review state entry "${key}" in ${stateFile}: ` +
          'expected bounded lastReviewedSha and canonical lastReviewedAt strings',
      );
    }
  }

  return state;
}

function isCanonicalReviewTimestamp(value) {
  if (!value) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateStateMetadata(metadata, stateFile) {
  if (
    !isPlainObject(metadata) ||
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

export function normalizeState(state) {
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
    if (hardenPermissions) {
      await enforcePrivateMode(stateFile, PRIVATE_FILE_MODE);
    }
    return normalizeState(validateState(JSON.parse(raw), stateFile));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveState(stateFile, state) {
  state = normalizeState(validateState(state, stateFile));
  const serialized = JSON.stringify(state, null, 2) + '\n';
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  if (serializedBytes > MAX_STATE_FILE_BYTES) {
    throw new Error(
      `Invalid review state in ${stateFile}: serialized state exceeds ${MAX_STATE_FILE_BYTES} bytes`,
    );
  }
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

export function recordReview(state, key, sha, reviewedAt) {
  state[normalizePrKey(key)] = {
    lastReviewedSha: sha,
    lastReviewedAt: reviewedAt,
  };
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

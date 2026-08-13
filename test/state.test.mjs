import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  candidateCursorFor,
  expireReviewState,
  flushStateDirectoryHandle,
  loadState,
  MAX_LEGACY_STATE_FILE_BYTES,
  migrateLegacyStateForReviewer,
  needsReview,
  normalizePrKey,
  normalizeState,
  prKey,
  recordCandidateCursor,
  recordReviewStateGcAfterKey,
  recordReviewStateGcPosition,
  REVIEW_STATE_COMMIT_INDETERMINATE,
  rotateReviewStateProofQueue,
  reviewScopeKey,
  reviewStateEntryCount,
  reviewStateGcAfterKey,
  reviewerKey,
  sameFileIdentity,
  samePathIdentity,
  saveState,
  serializeState,
  STATE_METADATA_KEY,
} from '../lib/state.mjs';
import {
  MAX_REVIEW_STATE_ENTRIES,
  MAX_REVIEW_STATE_KEY_CHARS,
  MAX_REVIEW_STATE_SHA_CHARS,
  MAX_STATE_FILE_BYTES,
} from '../lib/security-limits.mjs';

const reviewer = { hostname: 'github.com', username: 'OctoCat' };

function identityStats({ dev = 11n, ino = 22n, directory = true } = {}) {
  return {
    dev,
    ino,
    mode: 0o700n,
    birthtimeMs: 1,
    ctimeMs: 1,
    isDirectory: () => directory,
  };
}

test('file identity requires exact bigint dev and ino values', () => {
  assert.equal(
    sameFileIdentity(identityStats(), identityStats(), { platform: 'linux' }),
    true,
  );
  // Numeric Stats values are rejected even when their values happen to fit in
  // a JavaScript number. Identity checks must use the bigint Stats contract.
  assert.equal(
    sameFileIdentity(
      identityStats({ dev: 11, ino: 22 }),
      identityStats({ dev: 11, ino: 22 }),
      { platform: 'linux' },
    ),
    false,
  );
  // Mutable metadata must not substitute for a mismatched kernel identity.
  assert.equal(
    sameFileIdentity(
      identityStats({ dev: 11n, ino: 22n }),
      identityStats({ dev: 11n, ino: 23n }),
      { platform: 'linux' },
    ),
    false,
  );
  assert.equal(
    sameFileIdentity(
      identityStats({ dev: 0n, ino: 22n }),
      identityStats({ dev: 0n, ino: 22n }),
      { platform: 'linux' },
    ),
    false,
  );
  // Windows path and handle stats can report different volume identifiers;
  // the file index is the exact stable object identity across both calls.
  assert.equal(
    sameFileIdentity(
      identityStats({ dev: 11n, ino: 22n }),
      identityStats({ dev: 99n, ino: 22n }),
      { platform: 'win32' },
    ),
    true,
  );
  // Path-to-path checks must retain the volume component. Equal file indexes
  // from different volumes are not the same object.
  assert.equal(
    samePathIdentity(
      identityStats({ dev: 11n, ino: 22n }),
      identityStats({ dev: 99n, ino: 22n }),
      { platform: 'win32' },
    ),
    false,
  );
  assert.throws(
    () => sameFileIdentity(
      identityStats({ dev: 11n, ino: 22n }),
      identityStats({ dev: 99n, ino: 22n }),
      { platform: 'win32', requireVolumeMatch: true },
    ),
    /identity is unsupported on this Windows filesystem/u,
  );
  assert.throws(
    () => sameFileIdentity(
      identityStats({ dev: 11n, ino: 22n }),
      identityStats({ dev: 99n, ino: 23n }),
      { platform: 'win32' },
    ),
    /identity is unsupported on this Windows filesystem/u,
  );
  assert.throws(
    () => sameFileIdentity(
      identityStats({ dev: 11, ino: 22 }),
      identityStats({ dev: 11, ino: 22 }),
      { platform: 'win32' },
    ),
    /identity is unsupported on this Windows filesystem/u,
  );
});

test('Windows file identity round-trips handles and rejects a replacement', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  const replacementPath = path.join(directory, 'replacement.json');
  await writeFile(filePath, 'original');
  await writeFile(replacementPath, 'replacement');

  const handle = await open(filePath, 'r');
  t.after(() => handle.close().catch(() => {}));
  const handleStats = await handle.stat({ bigint: true });
  const pathStats = await lstat(filePath, { bigint: true });
  assert.equal(
    sameFileIdentity(handleStats, pathStats, { platform: 'win32' }),
    true,
  );

  const replacementStats = await lstat(replacementPath, { bigint: true });
  assert.throws(
    () => sameFileIdentity(handleStats, replacementStats, { platform: 'win32' }),
    /identity is unsupported on this Windows filesystem/u,
  );
});

test('review state keys are scoped to the GitHub reviewer', () => {
  assert.equal(reviewerKey(reviewer), 'github.com@octocat');
  assert.equal(
    prKey('owner/repo', 42, reviewer),
    'github.com@octocat::owner/repo#42',
  );
  assert.equal(
    reviewScopeKey('GITHUB.COM@OCTOCAT::OWNER/REPO#42'),
    'github.com@octocat::owner/repo',
  );
});

test('review state remains independent for two accounts reviewing one PR', () => {
  const state = {
    [prKey('owner/repo', 42, reviewer)]: {
      lastReviewedSha: 'abc123',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
  };
  assert.equal(needsReview(state, prKey('owner/repo', 42, reviewer), 'abc123'), false);
  assert.equal(
    needsReview(
      state,
      prKey('owner/repo', 42, {
        hostname: 'github.com',
        username: 'another-reviewer',
      }),
      'abc123',
    ),
    true,
  );
});

test('candidate scheduling cursors round-trip independently from review entries', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const state = {
    [prKey('owner/repo', 7, reviewer)]: {
      lastReviewedSha: 'sha-7',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
  };
  const cursorKey = 'github.com@octocat::owner/repo::requested';

  recordCandidateCursor(state, cursorKey, 25);
  assert.equal(candidateCursorFor(state, cursorKey), 25);
  await saveState(stateFile, state);

  const loaded = await loadState(stateFile);
  assert.equal(candidateCursorFor(loaded, cursorKey), 25);
  assert.deepEqual(loaded[STATE_METADATA_KEY], {
    version: 1,
    candidateCursors: { [cursorKey]: 25 },
  });
  assert.equal(loaded[prKey('owner/repo', 7, reviewer)].lastReviewedSha, 'sha-7');
});

test('review-state GC cursor round-trips additively with candidate cursors', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const state = {};

  recordReviewStateGcAfterKey(state, 'github.com@octocat::owner/repo#7');
  recordCandidateCursor(state, 'github.com@octocat::owner/repo::requested', 4);
  assert.equal(
    reviewStateGcAfterKey(state),
    'github.com@octocat::owner/repo#7',
  );
  await saveState(stateFile, state);

  const loaded = await loadState(stateFile);
  assert.deepEqual(loaded[STATE_METADATA_KEY], {
    version: 1,
    candidateCursors: {
      'github.com@octocat::owner/repo::requested': 4,
    },
    reviewStateGcAfterKey: 'github.com@octocat::owner/repo#7',
  });
});

test('review-state GC position is byte-stable and predecessor-readable', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const firstKey = prKey('owner/repo', 1, reviewer);
  const secondKey = prKey('owner/repo', 2, reviewer);
  const state = {
    [firstKey]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
    [secondKey]: {
      lastReviewedSha: 'sha-2',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
      reviewMarkerVersion: 1,
    },
  };
  recordCandidateCursor(state, 'github.com@octocat::owner/repo::requested', 4);
  const before = serializeState(state);

  recordReviewStateGcPosition(state, firstKey);
  const afterFirst = serializeState(state);
  assert.equal(afterFirst.serializedBytes, before.serializedBytes);
  assert.equal(reviewStateGcAfterKey(afterFirst.normalizedState), firstKey);

  recordReviewStateGcPosition(state, secondKey);
  const afterSecond = serializeState(state);
  assert.equal(afterSecond.serializedBytes, before.serializedBytes);
  assert.equal(reviewStateGcAfterKey(afterSecond.normalizedState), secondKey);
  assert.deepEqual(Object.keys(afterSecond.normalizedState[firstKey]), [
    'lastReviewedSha',
    'lastReviewedAt',
  ]);
  assert.deepEqual(Object.keys(afterSecond.normalizedState[secondKey]), [
    'lastReviewedAt',
    'lastReviewedSha',
    'reviewMarkerVersion',
  ]);
  assert.deepEqual(
    Object.keys(afterSecond.normalizedState[STATE_METADATA_KEY]).sort(),
    ['candidateCursors', 'version'],
  );

  await saveState(stateFile, state);
  const loaded = await loadState(stateFile);
  assert.equal(reviewStateGcAfterKey(loaded), secondKey);
});

test('proof queue rotation is byte-stable and predecessor-readable', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const scopeA = 'github.com@octocat::owner/a';
  const scopeB = 'github.com@octocat::owner/b';
  const state = Object.fromEntries([
    [`${scopeA}#1`, { lastReviewedSha: 'a-1', lastReviewedAt: '2026-07-25T00:00:00.000Z' }],
    [`${scopeA}#2`, { lastReviewedSha: 'a-2', lastReviewedAt: '2026-07-25T00:00:00.000Z' }],
    [`${scopeB}#1`, { lastReviewedSha: 'b-1', lastReviewedAt: '2026-07-25T00:00:00.000Z' }],
    [`${scopeB}#2`, { lastReviewedSha: 'b-2', lastReviewedAt: '2026-07-25T00:00:00.000Z' }],
  ]);
  recordCandidateCursor(state, `${scopeA}::requested`, 3);
  recordReviewStateGcAfterKey(state, `${scopeA}#2`);
  const before = serializeState(state);

  rotateReviewStateProofQueue(state, scopeA, `${scopeA}#1`);
  const after = serializeState(state);
  assert.equal(after.serializedBytes, before.serializedBytes);
  assert.deepEqual(
    Object.keys(after.normalizedState).filter((key) => key !== STATE_METADATA_KEY),
    [`${scopeB}#1`, `${scopeB}#2`, `${scopeA}#2`, `${scopeA}#1`],
  );
  assert.deepEqual(
    Object.keys(after.normalizedState[STATE_METADATA_KEY]).sort(),
    ['candidateCursors', 'reviewStateGcAfterKey', 'version'],
  );

  // This is the immediate predecessor's strict version-1 field whitelist.
  const predecessorFields = new Set([
    'version',
    'candidateCursors',
    'reviewStateGcAfterKey',
  ]);
  assert.equal(
    Object.keys(after.normalizedState[STATE_METADATA_KEY])
      .some((field) => !predecessorFields.has(field)),
    false,
  );
  await saveState(stateFile, state);
  const loaded = await loadState(stateFile);
  assert.deepEqual(Object.keys(loaded), Object.keys(after.normalizedState));
});

test('malformed candidate scheduling metadata fails closed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await writeFile(
    stateFile,
    JSON.stringify({
      [STATE_METADATA_KEY]: {
        version: 1,
        candidateCursors: { invalid: -1 },
      },
    }),
  );

  await assert.rejects(
    loadState(stateFile),
    /Invalid review state metadata.*candidate cursor is invalid/,
  );
});

test('malformed review-state GC cursors fail closed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  for (const reviewStateGcAfterKey of ['', 7, 'x'.repeat(1_025)]) {
    await writeFile(stateFile, JSON.stringify({
      [STATE_METADATA_KEY]: {
        version: 1,
        candidateCursors: {},
        reviewStateGcAfterKey,
      },
    }));
    await assert.rejects(
      loadState(stateFile),
      /review-state GC cursor is invalid/u,
    );
  }
});

test('malformed review-state proof cursors fail closed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  for (const metadata of [
    { reviewStateProofAfterScope: 'not-a-scope' },
    { reviewStateProofAfterKeys: [] },
    {
      reviewStateProofAfterKeys: {
        'github.com@octocat::owner/repo': 'github.com@octocat::other/repo#1',
      },
    },
  ]) {
    await writeFile(stateFile, JSON.stringify({
      [STATE_METADATA_KEY]: {
        version: 1,
        candidateCursors: {},
        ...metadata,
      },
    }));
    await assert.rejects(
      loadState(stateFile),
      /review-state proof .*cursor/u,
    );
  }
});

test('experimental proof cursor fields migrate once into predecessor-readable order', () => {
  const scopeA = 'github.com@octocat::owner/a';
  const scopeB = 'github.com@octocat::owner/b';
  const scopeC = 'github.com@octocat::owner/c';
  const normalized = normalizeState({
    [`${scopeA}#1`]: {
      lastReviewedSha: 'a-1',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
    [`${scopeA}#2`]: {
      lastReviewedSha: 'a-2',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
    [`${scopeB}#1`]: {
      lastReviewedSha: 'b-1',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
    [`${scopeB}#2`]: {
      lastReviewedSha: 'b-2',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
    [`${scopeC}#1`]: {
      lastReviewedSha: 'c-1',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
    [`${scopeC}#2`]: {
      lastReviewedSha: 'c-2',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
    [STATE_METADATA_KEY]: {
      version: 1,
      candidateCursors: {},
      reviewStateProofAfterScope: scopeB,
      reviewStateProofAfterKeys: {
        [scopeA]: `${scopeA}#1`,
        [scopeB]: `${scopeB}#1`,
        [scopeC]: `${scopeC}#1`,
      },
    },
  });

  assert.deepEqual(
    Object.keys(normalized),
    [
      `${scopeC}#2`, `${scopeC}#1`,
      `${scopeA}#2`, `${scopeA}#1`,
      `${scopeB}#2`, `${scopeB}#1`,
      STATE_METADATA_KEY,
    ],
  );
  assert.deepEqual(normalized[STATE_METADATA_KEY], {
    version: 1,
    candidateCursors: {},
  });
});

test('six-figure transitional proof queue migration does not overflow the call stack', {
  timeout: 10_000,
}, () => {
  const scope = 'github.com@a::o/a';
  const entryCount = 130_001;
  const state = Object.fromEntries(
    Array.from({ length: entryCount }, (_, index) => [
      `${scope}#${index + 1}`,
      {
        lastReviewedSha: 's',
        lastReviewedAt: '2026-08-11T00:00:00.000Z',
      },
    ]),
  );
  state[STATE_METADATA_KEY] = {
    version: 1,
    candidateCursors: {},
    reviewStateProofAfterScope: scope,
    reviewStateProofAfterKeys: {
      [scope]: `${scope}#1`,
    },
  };

  const normalized = normalizeState(state, { enforceEntryLimit: false });
  const keys = Object.keys(normalized);

  assert.equal(keys.length, entryCount + 1);
  assert.equal(keys[0], `${scope}#10`);
  assert.equal(keys.at(-2), `${scope}#1`);
  assert.deepEqual(normalized[STATE_METADATA_KEY], {
    version: 1,
    candidateCursors: {},
  });
});

test('case-only PR aliases normalize without accepting numeric aliases', () => {
  const canonicalKey = 'github.com@work::owner/repo#7';
  const state = {
    [canonicalKey]: {
      lastReviewedSha: 'sha-7',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
  };

  const caseAlias = 'GitHub.com@Work::OWNER/REPO#7';
  assert.equal(normalizePrKey(caseAlias), canonicalKey);
  assert.equal(needsReview(state, caseAlias, 'sha-7'), false);

  for (const numberText of ['007', ' 7 ', '7.0', '7e0', '0x7']) {
    const alias = `GitHub.com@Work::OWNER/REPO#${numberText}`;
    assert.equal(normalizePrKey(alias), alias);
    assert.throws(
      () => normalizeState({ [alias]: state[canonicalKey] }),
      /Invalid review state entry/u,
    );
  }
});

test('state normalization resolves case-only collisions independently of insertion order', () => {
  const uppercaseKey = 'GITHUB.COM@WORK::OWNER/REPO#7';
  const mixedCaseKey = 'github.com@work::owner/REPO#7';
  const uppercaseEntry = {
    lastReviewedSha: 'uppercase-sha',
    lastReviewedAt: '2026-07-25T00:00:00.000Z',
  };
  const mixedCaseEntry = {
    lastReviewedSha: 'mixed-case-sha',
    lastReviewedAt: '2026-07-25T01:00:00.000Z',
  };

  const forward = normalizeState({
    [uppercaseKey]: uppercaseEntry,
    [mixedCaseKey]: mixedCaseEntry,
  });
  const reverse = normalizeState({
    [mixedCaseKey]: mixedCaseEntry,
    [uppercaseKey]: uppercaseEntry,
  });

  assert.deepEqual(forward, reverse);
  assert.equal(forward['github.com@work::owner/repo#7'].lastReviewedSha, 'uppercase-sha');
});

test('legacy state migration adopts unscoped entries without overwriting scoped state', () => {
  const state = {
    'owner/repo#7': {
      lastReviewedSha: 'legacy-sha',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
    [prKey('owner/repo', 8, reviewer)]: {
      lastReviewedSha: 'stronger-sha',
      lastReviewedAt: '2026-07-25T01:00:00.000Z',
    },
    'owner/repo#8': {
      lastReviewedSha: 'legacy-sha-that-must-not-win',
      lastReviewedAt: '2026-07-25T02:00:00.000Z',
    },
  };

  assert.equal(migrateLegacyStateForReviewer(state, reviewer), true);
  assert.deepEqual(Object.keys(state).sort(), [
    'github.com@octocat::owner/repo#7',
    'github.com@octocat::owner/repo#8',
  ]);
  assert.deepEqual(state[prKey('owner/repo', 7, reviewer)], {
    lastReviewedSha: 'legacy-sha',
    lastReviewedAt: '2026-07-25T00:00:00.000Z',
  });
  assert.deepEqual(state[prKey('owner/repo', 8, reviewer)], {
    lastReviewedSha: 'stronger-sha',
    lastReviewedAt: '2026-07-25T01:00:00.000Z',
  });
});

test('loading malformed state roots fails closed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');

  for (const malformed of ['[]', 'null', '"state"', '42']) {
    await writeFile(stateFile, `${malformed}\n`);
    await assert.rejects(loadState(stateFile), /Invalid review state.*expected a JSON object/);
  }
});

test('loading malformed review entries fails closed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await writeFile(
    stateFile,
    JSON.stringify({
      'owner/repo#1': { lastReviewedSha: 'sha-1' },
    }),
  );

  await assert.rejects(
    loadState(stateFile),
    /Invalid review state entry.*canonical key, bounded record fields/u,
  );
});

test('review-state fields and timestamps are bounded and canonical', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const entry = {
    lastReviewedSha: 'sha-1',
    lastReviewedAt: '2026-08-11T00:00:00.000Z',
  };
  const malformedStates = [
    { ['x'.repeat(MAX_REVIEW_STATE_KEY_CHARS + 1)]: entry },
    { 'owner/repo#1': { ...entry, lastReviewedSha: '' } },
    {
      'owner/repo#1': {
        ...entry,
        lastReviewedSha: 's'.repeat(MAX_REVIEW_STATE_SHA_CHARS + 1),
      },
    },
    { 'owner/repo#1': { ...entry, lastReviewedAt: 'not-a-date' } },
    { 'owner/repo#1': { ...entry, lastReviewedAt: '2026-08-11T00:00:00Z' } },
    { 'owner/repo#1': { ...entry, reviewMarkerVersion: 2 } },
    { 'owner/repo#1': { ...entry, unexpected: true } },
    {
      'owner/repo#1': {
        ...entry,
        lastReviewedAt: new Date(Date.now() + 5 * 60 * 1_000 + 1_000).toISOString(),
      },
    },
  ];

  for (const state of malformedStates) {
    await assert.rejects(saveState(stateFile, state), /Invalid review state entry/u);
  }
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });
});

test('review state accepts only canonical identifiers and optional marker version 1', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const entry = {
    lastReviewedSha: 'sha-1',
    lastReviewedAt: '2026-08-11T00:00:00.000Z',
    reviewMarkerVersion: 1,
  };

  await saveState(stateFile, {
    'GITHUB.COM@OCTOCAT::OWNER/REPO#7': entry,
    'LEGACY/REPO#8': { ...entry, reviewMarkerVersion: undefined },
  });
  assert.deepEqual(await loadState(stateFile), {
    'github.com@octocat::owner/repo#7': entry,
    'legacy/repo#8': {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-08-11T00:00:00.000Z',
    },
  });

  for (const key of [
    'github.com@@octocat::owner/repo#7',
    'github.com@octocat::owner/repo#0',
    'github.com@octocat::owner/repo#01',
    'github.com@octocat::owner/repo#9007199254740992',
    'github.com@octocat::owner/repo/extra#7',
    'bad host@octocat::owner/repo#7',
  ]) {
    await assert.rejects(
      saveState(stateFile, { [key]: entry }),
      /Invalid review state entry/u,
    );
  }
});

test('invalid state is hardened through its verified handle before rejection', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await writeFile(stateFile, JSON.stringify({
    'owner/repo#01': {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-08-11T00:00:00.000Z',
    },
  }));
  await chmod(stateFile, 0o644);

  await assert.rejects(loadState(stateFile), /Invalid review state entry/u);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
});

test('loading a symlink state never reads or chmods its target', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const victim = path.join(directory, 'victim.json');
  await writeFile(victim, '{}\n', { mode: 0o644 });
  await chmod(victim, 0o644);
  await symlink(victim, stateFile);

  await assert.rejects(
    loadState(stateFile),
    /regular non-symbolic-link file|ELOOP/u,
  );

  assert.equal(await readFile(victim, 'utf8'), '{}\n');
  assert.equal((await stat(victim)).mode & 0o777, 0o644);
  assert.equal((await lstat(stateFile)).isSymbolicLink(), true);
});

test('loading state from an owner-controlled conventional parent remains compatible', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await writeFile(stateFile, '{}\n', { mode: 0o644 });
  await chmod(stateFile, 0o644);
  await chmod(directory, 0o755);

  assert.deepEqual(await loadState(stateFile), {});
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
});

test('parent replacement while loading fails closed instead of returning empty state', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-load-parent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  const movedDirectory = path.join(root, 'private-moved');
  await mkdir(directory, { mode: 0o700 });
  const stateFile = path.join(directory, 'state.json');
  await writeFile(stateFile, '{}\n', { mode: 0o600 });

  await assert.rejects(
    loadState(stateFile, {
      hardenHandle: async () => {
        await rename(directory, movedDirectory);
        await mkdir(directory, { mode: 0o700 });
        await writeFile(stateFile, '{"replacement":true}\n', { mode: 0o600 });
      },
    }),
    /parent directory identity changed/u,
  );

  assert.equal(await readFile(stateFile, 'utf8'), '{"replacement":true}\n');
  assert.equal(
    await readFile(path.join(movedDirectory, 'state.json'), 'utf8'),
    '{}\n',
  );
});

test('shared serialization reports exact UTF-8 bytes', () => {
  const state = {
    'owner/repo#1': {
      lastReviewedSha: '€-sha',
      lastReviewedAt: '2026-08-11T00:00:00.000Z',
      reviewMarkerVersion: 1,
    },
  };
  const result = serializeState(state);
  assert.equal(
    result.serializedBytes,
    Buffer.byteLength(result.serialized, 'utf8'),
  );
  assert.ok(result.serializedBytes > result.serialized.length);
});

test('review-state load is byte-bounded before JSON parsing', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await writeFile(stateFile, Buffer.alloc(MAX_STATE_FILE_BYTES + 1, 0x20));

  await assert.rejects(
    loadState(stateFile),
    new RegExp(`file exceeds ${MAX_STATE_FILE_BYTES} bytes`, 'u'),
  );
});

test('bounded legacy load admits valid predecessor bytes for migration only', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const key = prKey('owner/repo', 1, reviewer);
  const raw = JSON.stringify({
    [key]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-08-11T00:00:00.000Z',
    },
  }) + ' '.repeat(MAX_STATE_FILE_BYTES);
  await writeFile(stateFile, raw);

  await assert.rejects(
    loadState(stateFile),
    new RegExp(`file exceeds ${MAX_STATE_FILE_BYTES} bytes`, 'u'),
  );
  const migratable = await loadState(stateFile, {
    allowEntryLimitMigration: true,
  });
  assert.equal(migratable[key].lastReviewedSha, 'sha-1');
  await writeFile(
    stateFile,
    JSON.stringify({ [key]: migratable[key] }) +
      ' '.repeat(MAX_LEGACY_STATE_FILE_BYTES),
  );
  await assert.rejects(
    loadState(stateFile, { allowEntryLimitMigration: true }),
    new RegExp(`file exceeds ${MAX_LEGACY_STATE_FILE_BYTES} bytes`, 'u'),
  );
});

test('review-state entry count is bounded on load and save', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const entry = {
    lastReviewedSha: 'sha',
    lastReviewedAt: '2026-08-11T00:00:00.000Z',
  };
  const oversized = Object.fromEntries(
    Array.from({ length: MAX_REVIEW_STATE_ENTRIES + 1 }, (_, index) => [
      `owner/repo#${index + 1}`,
      entry,
    ]),
  );

  await assert.rejects(saveState(stateFile, oversized), /too many review entries/u);
  await saveState(stateFile, oversized, { allowEntryLimitMigration: true });
  await assert.rejects(loadState(stateFile), /too many review entries/u);
  const migratable = await loadState(stateFile, {
    allowEntryLimitMigration: true,
  });
  assert.equal(Object.keys(migratable).length, MAX_REVIEW_STATE_ENTRIES + 1);
  await writeFile(stateFile, JSON.stringify(oversized));
  await assert.rejects(loadState(stateFile), /too many review entries/u);
});

test('serialized review state is byte-bounded before creating the target file', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const state = {};
  for (let index = 0; index < MAX_REVIEW_STATE_ENTRIES; index += 1) {
    state[prKey('owner/repo', index + 1, reviewer)] = {
      lastReviewedSha: '€'.repeat(MAX_REVIEW_STATE_SHA_CHARS),
      lastReviewedAt: '2026-08-11T00:00:00.000Z',
    };
  }
  state[STATE_METADATA_KEY] = {
    version: 1,
    candidateCursors: Object.fromEntries(
      Array.from({ length: MAX_REVIEW_STATE_ENTRIES }, (_, index) => {
        const prefix = String(index).padStart(5, '0');
        return [`${prefix}${'€'.repeat(507)}`, index];
      }),
    ),
  };

  await assert.rejects(
    saveState(stateFile, state),
    new RegExp(`serialized state exceeds ${MAX_STATE_FILE_BYTES} bytes`, 'u'),
  );
  await saveState(stateFile, state, { allowEntryLimitMigration: true });
  assert.ok((await stat(stateFile)).size > MAX_STATE_FILE_BYTES);
  await assert.rejects(
    loadState(stateFile),
    new RegExp(`file exceeds ${MAX_STATE_FILE_BYTES} bytes`, 'u'),
  );
  assert.equal(
    Object.keys(await loadState(stateFile, {
      allowEntryLimitMigration: true,
    })).length,
    MAX_REVIEW_STATE_ENTRIES + 1,
  );
});

test('review-state retention expires entries at exactly 365 days', () => {
  const now = Date.parse('2026-08-11T00:00:00.000Z');
  const state = {
    'github.com@work::owner/repo#1': {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2025-08-11T00:00:00.000Z',
    },
    'enterprise.example@old::owner/repo#2': {
      lastReviewedSha: 'sha-2',
      lastReviewedAt: '2025-08-11T00:00:00.001Z',
    },
    [STATE_METADATA_KEY]: {
      version: 1,
      candidateCursors: {},
    },
  };

  assert.deepEqual(
    expireReviewState(state, now),
    ['github.com@work::owner/repo#1'],
  );
  assert.equal(reviewStateEntryCount(state), 1);
  assert.ok(state['enterprise.example@old::owner/repo#2']);
  assert.ok(state[STATE_METADATA_KEY]);
});

test('loading existing state hardens its file mode by default', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await writeFile(
    stateFile,
    JSON.stringify({
      'owner/repo#1': {
        lastReviewedSha: 'sha-1',
        lastReviewedAt: '2026-07-25T00:00:00.000Z',
      },
    }),
  );
  await chmod(stateFile, 0o644);

  await loadState(stateFile);

  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
});

test('loading mixed-case scoped and unscoped aliases canonicalizes them deterministically', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await writeFile(
    stateFile,
    JSON.stringify({
      'GITHUB.COM@WORK::OWNER/REPO#7': {
        lastReviewedSha: 'legacy-sha',
        lastReviewedAt: '2026-07-25T00:00:00.000Z',
      },
      'github.com@work::owner/REPO#7': {
        lastReviewedSha: 'alias-sha',
        lastReviewedAt: '2026-07-25T01:00:00.000Z',
      },
      'github.com@work::owner/repo#7': {
        lastReviewedSha: 'canonical-sha',
        lastReviewedAt: '2026-07-25T02:00:00.000Z',
      },
      'OWNER/REPO#8': {
        lastReviewedSha: 'unscoped-sha',
        lastReviewedAt: '2026-07-25T03:00:00.000Z',
      },
    }),
  );

  const state = await loadState(stateFile);
  assert.deepEqual(Object.keys(state), [
    'github.com@work::owner/repo#7',
    'owner/repo#8',
  ]);
  assert.equal(state['github.com@work::owner/repo#7'].lastReviewedSha, 'canonical-sha');
  assert.equal(state['owner/repo#8'].lastReviewedSha, 'unscoped-sha');

  await saveState(stateFile, state);
  assert.deepEqual(Object.keys(await loadState(stateFile)), [
    'github.com@work::owner/repo#7',
    'owner/repo#8',
  ]);
});

test('saving malformed state is rejected before writing', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');

  await assert.rejects(saveState(stateFile, []), /Invalid review state.*expected a JSON object/);
  await assert.rejects(saveState(stateFile, { 'owner/repo#1': null }), /Invalid review state entry/);
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });
});

test('state saves atomically without leaving temporary files', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'nested', 'state.json');
  const state = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };

  await saveState(stateFile, state);
  assert.deepEqual(await loadState(stateFile), state);
  if (process.platform !== 'win32') {
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  }
  const replacement = {
    ...state,
    [prKey('owner/repo', 2, reviewer)]: {
      lastReviewedSha: 'sha-2',
      lastReviewedAt: '2026-07-28T01:00:00.000Z',
    },
  };
  await saveState(stateFile, replacement);
  assert.deepEqual(await loadState(stateFile), replacement);
  assert.deepEqual(await readdir(path.dirname(stateFile)), ['state.json']);
});

test('permission hardening failure leaves the previous state committed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const initialState = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  await saveState(stateFile, initialState);
  const originalBytes = await readFile(stateFile, 'utf8');
  const replacement = {
    ...initialState,
    [prKey('owner/repo', 2, reviewer)]: {
      lastReviewedSha: 'sha-2',
      lastReviewedAt: '2026-07-28T01:00:00.000Z',
    },
  };

  await assert.rejects(
    saveState(stateFile, replacement, {
      hardenHandle: async () => { throw new Error('chmod failed'); },
    }),
    /chmod failed/u,
  );

  assert.equal(await readFile(stateFile, 'utf8'), originalBytes);
  assert.deepEqual(await readdir(directory), ['state.json']);
});

test('temporary-path replacement cannot chmod a victim or replace state', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const victim = path.join(directory, 'victim.txt');
  const initialState = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  await saveState(stateFile, initialState);
  await writeFile(victim, 'victim', { mode: 0o644 });
  await chmod(victim, 0o644);
  const originalBytes = await readFile(stateFile, 'utf8');

  await assert.rejects(
    saveState(stateFile, {}, {
      beforeRename: async (temporaryPath) => {
        await rm(temporaryPath);
        await symlink(victim, temporaryPath);
      },
    }),
    /temporary file identity changed/u,
  );

  assert.equal(await readFile(stateFile, 'utf8'), originalBytes);
  assert.equal((await lstat(stateFile)).isFile(), true);
  assert.equal((await lstat(stateFile)).isSymbolicLink(), false);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.equal(await readFile(victim, 'utf8'), 'victim');
  assert.equal((await stat(victim)).mode & 0o777, 0o644);
  assert.deepEqual((await readdir(directory)).sort(), ['state.json', 'victim.txt']);
});

test('post-check substitution cannot commit attacker content', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const initialState = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  await saveState(stateFile, initialState);
  const originalBytes = await readFile(stateFile, 'utf8');

  await assert.rejects(
    saveState(stateFile, {}, {
      afterIdentityCheck: async (temporaryPath) => {
        await rm(temporaryPath);
        await writeFile(temporaryPath, '{"attacker":true}\n');
      },
    }),
    /temporary file identity changed before atomic commit/u,
  );

  assert.equal(await readFile(stateFile, 'utf8'), originalBytes);
  assert.equal((await lstat(stateFile)).isFile(), true);
  assert.equal((await lstat(stateFile)).isSymbolicLink(), false);
  assert.deepEqual(await readdir(directory), ['state.json']);
});

test('atomic replacement failure preserves the previous state without backup recovery', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const initialState = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  await saveState(stateFile, initialState);
  const originalBytes = await readFile(stateFile, 'utf8');

  await assert.rejects(
    saveState(stateFile, {}, {
      commitRename: async () => { throw new Error('simulated commit failure'); },
    }),
    /simulated commit failure/u,
  );

  assert.equal(await readFile(stateFile, 'utf8'), originalBytes);
  assert.deepEqual(await readdir(directory), ['state.json']);
});

test('a post-rename verification failure reports an indeterminate committed state', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const replacement = {
    [prKey('owner/repo', 2, reviewer)]: {
      lastReviewedSha: 'sha-2',
      lastReviewedAt: '2026-07-28T01:00:00.000Z',
    },
  };

  await assert.rejects(
    saveState(stateFile, replacement, {
      afterCommitRename: async () => {
        throw new Error('simulated post-rename verification failure');
      },
    }),
    (err) => {
      assert.equal(err.code, REVIEW_STATE_COMMIT_INDETERMINATE);
      assert.equal(err.commitStatus, 'indeterminate');
      assert.equal(err.committed, true);
      assert.match(err.cause.message, /post-rename verification failure/u);
      return true;
    },
  );

  assert.deepEqual(await loadState(stateFile), replacement);
  assert.deepEqual(await readdir(directory), ['state.json']);
});

test('temporary flush failure leaves the previous state committed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const initialState = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  await saveState(stateFile, initialState);
  const originalBytes = await readFile(stateFile, 'utf8');

  await assert.rejects(
    saveState(stateFile, {}, {
      flushHandle: async () => { throw new Error('simulated flush failure'); },
    }),
    /simulated flush failure/u,
  );

  assert.equal(await readFile(stateFile, 'utf8'), originalBytes);
  assert.deepEqual(await readdir(directory), ['state.json']);
});

test('state commit flushes bytes then rename then parent directory', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const events = [];

  const result = await saveState(stateFile, {}, {
    flushHandle: async (handle) => {
      events.push('temp-sync');
      await handle.sync();
    },
    commitRename: async (...args) => {
      events.push('rename');
      await rename(...args);
    },
    flushParentHandle: async (handle) => {
      events.push('parent-sync');
      await flushStateDirectoryHandle(handle, {
        platform: process.platform,
      });
    },
  });

  assert.deepEqual(events, ['temp-sync', 'rename', 'parent-sync']);
  if (process.platform === 'win32') {
    assert.equal(result.committed, true);
    assert.equal(result.directorySynced, false);
    assert.match(result.postCommitError.message, /unsupported on this Windows filesystem/u);
  } else {
    assert.deepEqual(result, { committed: true, directorySynced: true });
  }
  assert.deepEqual(await loadState(stateFile), {});
});

test('parent flush failure reports committed state without rollback', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await saveState(stateFile, {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  });
  const replacement = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'new-sha',
      lastReviewedAt: '2026-07-28T01:00:00.000Z',
    },
  };
  const warnings = [];

  const result = await saveState(stateFile, replacement, {
    flushParentHandle: async () => { throw new Error('directory fsync failed'); },
    onPostCommitError: async (err) => { warnings.push(err.message); },
  });

  assert.equal(result.committed, true);
  assert.equal(result.directorySynced, false);
  assert.match(result.postCommitError.message, /directory fsync failed/u);
  assert.deepEqual(warnings, ['directory fsync failed']);
  assert.deepEqual(await loadState(stateFile), replacement);
  assert.deepEqual(await readdir(directory), ['state.json']);
});

test('unsupported Windows parent flush is reported as committed but not durable', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const warnings = [];
  const unsupported = Object.assign(new Error('invalid directory handle'), {
    code: 'EINVAL',
  });

  const result = await saveState(stateFile, {}, {
    flushParentHandle: (handle) => flushStateDirectoryHandle(handle, {
      platform: 'win32',
      syncHandle: async () => { throw unsupported; },
    }),
    onPostCommitError: async (err) => { warnings.push(err.message); },
  });

  assert.equal(result.committed, true);
  assert.equal(result.directorySynced, false);
  assert.match(result.postCommitError.message, /unsupported on this Windows filesystem/u);
  assert.equal(warnings.length, 1);
  assert.deepEqual(await loadState(stateFile), {});
});

test('temporary cleanup failure is surfaced without deleting the previous state', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const initialState = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  await saveState(stateFile, initialState);
  const originalBytes = await readFile(stateFile, 'utf8');

  await assert.rejects(
    saveState(stateFile, {}, {
      commitRename: async () => { throw new Error('simulated commit failure'); },
      removeTemporary: async () => { throw new Error('simulated cleanup failure'); },
    }),
    /simulated commit failure.*temporary cleanup also failed.*simulated cleanup failure/u,
  );

  assert.equal(await readFile(stateFile, 'utf8'), originalBytes);
  assert.equal(
    (await readdir(directory)).some((name) => name.includes('.tmp-')),
    true,
  );
});

test('parent replacement after verification cannot redirect commit or cleanup', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-parent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  const movedDirectory = path.join(root, 'private-moved');
  await mkdir(directory, { mode: 0o700 });
  const stateFile = path.join(directory, 'state.json');
  const initialState = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  await saveState(stateFile, initialState);
  const originalBytes = await readFile(stateFile, 'utf8');
  let replacementTemporaryPath;

  await assert.rejects(
    saveState(stateFile, {}, {
      afterIdentityCheck: async (temporaryPath) => {
        await rename(directory, movedDirectory);
        await mkdir(directory, { mode: 0o700 });
        await writeFile(stateFile, 'replacement-target\n');
        replacementTemporaryPath = path.join(
          directory,
          path.basename(temporaryPath),
        );
        await writeFile(replacementTemporaryPath, 'replacement-temp\n');
      },
    }),
    /temporary file identity changed.*temporary cleanup also failed.*parent directory identity changed/u,
  );

  assert.equal(await readFile(stateFile, 'utf8'), 'replacement-target\n');
  assert.equal(await readFile(replacementTemporaryPath, 'utf8'), 'replacement-temp\n');
  assert.equal(
    await readFile(path.join(movedDirectory, 'state.json'), 'utf8'),
    originalBytes,
  );

  await rm(directory, { recursive: true, force: true });
  await rename(movedDirectory, directory);
  assert.deepEqual(await loadState(stateFile), initialState);
});

test('parent swap at the final rename boundary cannot report attacker content committed', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  const movedDirectory = path.join(root, 'private-moved');
  await mkdir(directory, { mode: 0o700 });
  const stateFile = path.join(directory, 'state.json');
  const initialState = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  await saveState(stateFile, initialState);
  const originalBytes = await readFile(stateFile, 'utf8');

  await assert.rejects(
    saveState(stateFile, {}, {
      beforeCommitRename: async (temporaryPath) => {
        await rename(directory, movedDirectory);
        await mkdir(directory, { mode: 0o700 });
        await writeFile(stateFile, 'attacker-old\n', { mode: 0o600 });
        await writeFile(
          path.join(directory, path.basename(temporaryPath)),
          'attacker-new\n',
          { mode: 0o600 },
        );
      },
    }),
    /parent directory identity changed|could not be bound/u,
  );

  assert.equal(await readFile(stateFile, 'utf8'), 'attacker-new\n');
  assert.equal(
    await readFile(path.join(movedDirectory, 'state.json'), 'utf8'),
    originalBytes,
  );
  assert.equal(
    (await readdir(movedDirectory)).some((name) => name.includes('.tmp-')),
    true,
  );
});

test('saving rejects an unsafe existing parent without tightening it', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-shared-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o775);

  const stateFile = path.join(root, 'state.json');
  await assert.rejects(
    saveState(stateFile, {}),
    /parent directory must be user-owned and not group\/other-writable/u,
  );

  assert.equal((await stat(root)).mode & 0o777, 0o775);
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });
});

test('absolute state path under a conventional parent preserves atomic rollback', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-absolute-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  const stateFile = path.resolve(directory, 'state.json');
  const initial = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  await saveState(stateFile, initial);
  const originalBytes = await readFile(stateFile, 'utf8');

  await assert.rejects(
    saveState(stateFile, {}, {
      commitRename: async () => { throw new Error('absolute commit failed'); },
    }),
    /absolute commit failed/u,
  );

  assert.equal(await readFile(stateFile, 'utf8'), originalBytes);
  assert.deepEqual(await loadState(stateFile), initial);
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
});

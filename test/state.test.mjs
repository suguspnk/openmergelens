import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  candidateCursorFor,
  expireReviewState,
  loadState,
  migrateLegacyStateForReviewer,
  needsReview,
  normalizePrKey,
  normalizeState,
  prKey,
  recordCandidateCursor,
  recordReviewStateGcAfterKey,
  recordReviewStateGcPosition,
  rotateReviewStateProofQueue,
  reviewScopeKey,
  reviewStateEntryCount,
  reviewStateGcAfterKey,
  reviewerKey,
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

test('invalid state is rejected before permission hardening', {
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
  assert.equal((await stat(stateFile)).mode & 0o777, 0o644);
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
  await assert.rejects(
    saveState(stateFile, state, { allowEntryLimitMigration: true }),
    new RegExp(`serialized state exceeds ${MAX_STATE_FILE_BYTES} bytes`, 'u'),
  );
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });
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
      enforceMode: async () => { throw new Error('chmod failed'); },
    }),
    /chmod failed/u,
  );

  assert.equal(await readFile(stateFile, 'utf8'), originalBytes);
  assert.deepEqual(await readdir(directory), ['state.json']);
});

test('saving an absolute state path does not tighten its existing parent', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-shared-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);

  const stateFile = path.join(root, 'state.json');
  await saveState(stateFile, {});

  assert.equal((await stat(root)).mode & 0o777, 0o755);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
});

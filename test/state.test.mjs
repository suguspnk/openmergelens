import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  candidateCursorFor,
  loadState,
  migrateLegacyStateForReviewer,
  needsReview,
  normalizePrKey,
  normalizeState,
  prKey,
  recordCandidateCursor,
  reconcileRequestedReviewState,
  reviewerKey,
  saveState,
  STATE_METADATA_KEY,
} from '../lib/state.mjs';

const reviewer = { hostname: 'github.com', username: 'OctoCat' };

test('review state keys are scoped to the GitHub reviewer', () => {
  assert.equal(reviewerKey(reviewer), 'github.com@octocat');
  assert.equal(
    prKey('owner/repo', 42, reviewer),
    'github.com@octocat::owner/repo#42',
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

test('requested-review reconciliation prunes only absent scoped entries and the obsolete tracked cursor', () => {
  const otherReviewer = { hostname: 'github.com', username: 'another-reviewer' };
  const retainedKey = prKey('owner/repo', 7, reviewer);
  const removedKey = prKey('owner/repo', 8, reviewer);
  const otherRepoKey = prKey('owner/other', 8, reviewer);
  const otherReviewerKey = prKey('owner/repo', 8, otherReviewer);
  const requestedCursor = 'github.com@octocat::owner/repo::requested';
  const trackedCursor = 'github.com@octocat::owner/repo::tracked';
  const otherTrackedCursor = 'github.com@octocat::owner/other::tracked';
  const entry = {
    lastReviewedSha: 'sha',
    lastReviewedAt: '2026-07-25T00:00:00.000Z',
  };
  const state = {
    [retainedKey]: entry,
    [removedKey]: entry,
    [otherRepoKey]: entry,
    [otherReviewerKey]: entry,
    'owner/repo#9': entry,
  };
  recordCandidateCursor(state, requestedCursor, 2);
  recordCandidateCursor(state, trackedCursor, 3);
  recordCandidateCursor(state, otherTrackedCursor, 4);

  assert.equal(reconcileRequestedReviewState(state, {
    reviewer,
    repo: 'OWNER/REPO',
    requestedNumbers: [7],
  }), true);
  assert.deepEqual(Object.keys(state).sort(), [
    STATE_METADATA_KEY,
    otherReviewerKey,
    otherRepoKey,
    'owner/repo#9',
    retainedKey,
  ].sort());
  assert.deepEqual(state[STATE_METADATA_KEY].candidateCursors, {
    [requestedCursor]: 2,
    [otherTrackedCursor]: 4,
  });
  assert.equal(reconcileRequestedReviewState(state, {
    reviewer,
    repo: 'owner/repo',
    requestedNumbers: [7],
  }), false);
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

test('positive numeric PR aliases normalize to decimal keys without losing scope', () => {
  const canonicalKey = 'github.com@work::owner/repo#7';
  const state = {
    [canonicalKey]: {
      lastReviewedSha: 'sha-7',
      lastReviewedAt: '2026-07-25T00:00:00.000Z',
    },
  };

  for (const numberText of ['007', ' 7 ', '7.0', '7e0', '0x7']) {
    const alias = `GitHub.com@Work::OWNER/REPO#${numberText}`;
    assert.equal(normalizePrKey(alias), canonicalKey);
    assert.equal(needsReview(state, alias, 'sha-7'), false);
  }

  const normalized = normalizeState({
    'github.com@work::owner/repo#007': state[canonicalKey],
  });
  delete normalized[canonicalKey];
  assert.deepEqual(normalized, {});
});

test('state normalization resolves numeric-key collisions independently of insertion order', () => {
  const leadingZeroKey = 'github.com@work::owner/repo#007';
  const decimalFormKey = 'github.com@work::owner/repo#7.0';
  const leadingZeroEntry = {
    lastReviewedSha: 'leading-zero-sha',
    lastReviewedAt: '2026-07-25T00:00:00.000Z',
  };
  const decimalFormEntry = {
    lastReviewedSha: 'decimal-form-sha',
    lastReviewedAt: '2026-07-25T01:00:00.000Z',
  };

  const forward = normalizeState({
    [leadingZeroKey]: leadingZeroEntry,
    [decimalFormKey]: decimalFormEntry,
  });
  const reverse = normalizeState({
    [decimalFormKey]: decimalFormEntry,
    [leadingZeroKey]: leadingZeroEntry,
  });

  assert.deepEqual(forward, reverse);
  assert.equal(forward['github.com@work::owner/repo#7'].lastReviewedSha, 'leading-zero-sha');
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
    /Invalid review state entry.*expected lastReviewedSha and lastReviewedAt strings/,
  );
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  candidateCursorFor,
  expireReviewState,
  flushStateDirectoryHandle,
  loadState as loadStateImplementation,
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
  saveState as saveStateImplementation,
  serializeState,
  STATE_METADATA_KEY,
} from '../lib/state.mjs';
import {
  MAX_REVIEW_STATE_ENTRIES,
  MAX_REVIEW_STATE_KEY_CHARS,
  MAX_REVIEW_STATE_SHA_CHARS,
  MAX_REVIEW_STATE_TEMPORARIES,
  MAX_STATE_FILE_BYTES,
} from '../lib/security-limits.mjs';

const saveStateModuleUrl = new URL('../lib/state.mjs', import.meta.url).href;

const reviewer = { hostname: 'github.com', username: 'OctoCat' };

// Node 22 on the hosted Windows runner exposes a valid file index but reports
// a zero volume field for pathname Stats. Production path identity remains
// strict; this seam gives simulated Windows tests the explicit, valid volume
// proof they need without weakening the identity helper or hiding an actual
// replacement. Custom lstat seams are wrapped after they make their own
// mutation, so a test-supplied mismatched volume remains observable.
function windowsTestStats(stats) {
  const devUnavailable = typeof stats?.dev === 'bigint'
    ? stats.dev <= 0n
    : typeof stats?.dev === 'number' &&
      (!Number.isSafeInteger(stats.dev) || stats.dev <= 0);
  const inoAvailable = typeof stats?.ino === 'bigint'
    ? stats.ino > 0n
    : typeof stats?.ino === 'number' &&
      Number.isSafeInteger(stats.ino) &&
      stats.ino > 0;
  if (process.platform !== 'win32' ||
      !devUnavailable ||
      !inoAvailable) {
    return stats;
  }
  const normalized = Object.assign(
    Object.create(Object.getPrototypeOf(stats)),
    stats,
  );
  normalized.dev = 1n;
  return normalized;
}

function windowsTestOptions(options = {}) {
  if (process.platform !== 'win32' || options.platform === 'linux') {
    return options;
  }
  const baseLstat = options.lstat || lstat;
  return {
    ...options,
    lstat: async (...args) => windowsTestStats(await baseLstat(...args)),
  };
}

function saveState(...args) {
  const [stateFile, state, options] = args;
  return saveStateImplementation(stateFile, state, windowsTestOptions(options));
}

function loadState(...args) {
  const [stateFile, options] = args;
  return loadStateImplementation(stateFile, windowsTestOptions(options));
}

function runWindowsSaveChild(stateFile) {
  const script = `
    import { saveState, prKey } from ${JSON.stringify(saveStateModuleUrl)};
    import { lstat as fsLstat } from 'node:fs/promises';
    const lstat = async (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith('\\\\')) {
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        };
      }
      const stats = await fsLstat(...args);
      const devUnavailable = typeof stats.dev === 'bigint'
        ? stats.dev <= 0n
        : typeof stats.dev === 'number' &&
          (!Number.isSafeInteger(stats.dev) || stats.dev <= 0);
      const inoAvailable = typeof stats.ino === 'bigint'
        ? stats.ino > 0n
        : typeof stats.ino === 'number' &&
          Number.isSafeInteger(stats.ino) &&
          stats.ino > 0;
      if (!devUnavailable ||
          !inoAvailable) return stats;
      const normalized = Object.assign(
        Object.create(Object.getPrototypeOf(stats)),
        stats,
      );
      normalized.dev = 1n;
      return normalized;
    };
    const state = {
      [prKey('owner/repo', 1, { hostname: 'github.com', username: 'child' })]: {
        lastReviewedSha: 'child-sha',
        lastReviewedAt: '2026-07-28T00:00:00.000Z',
      },
    };
    try {
      await saveState(process.argv[1], state, {
        platform: 'win32',
        lstat,
        hardenHandle: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          throw new Error('child pre-rename failure');
        },
      });
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(JSON.stringify({ message: error.message }));
      process.exitCode = 1;
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, stateFile], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

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
  // Handle/path observations may expose different dev representations on
  // Windows; production callers bind the path with an independent snapshot.
  assert.equal(
    sameFileIdentity(
      identityStats({ dev: 11n, ino: 22n }),
      identityStats({ dev: 99n, ino: 22n }),
      { platform: 'win32', allowMixedHandlePathVolume: true },
    ),
    true,
  );
  assert.throws(
    () => sameFileIdentity(
      identityStats({ dev: 11, ino: 22 }),
      identityStats({ dev: 99, ino: 22 }),
      { platform: 'win32' },
    ),
    /identity is unsupported on this Windows filesystem/u,
  );
  assert.equal(
    sameFileIdentity(
      identityStats({ dev: 11, ino: 22 }),
      identityStats({ dev: 11, ino: 22 }),
      { platform: 'win32' },
    ),
    true,
  );
  // Hosted Windows Node versions can mix numeric and bigint Stats values
  // between a descriptor and its pathname. Safe numeric fields normalize to
  // exact bigint values; an imprecise numeric value remains unsupported.
  assert.equal(
    sameFileIdentity(
      identityStats({ dev: 11, ino: 22 }),
      identityStats({ dev: 11n, ino: 22n }),
      { platform: 'win32', requireVolumeMatch: true },
    ),
    true,
  );
  assert.equal(
    sameFileIdentity(
      identityStats({ dev: 11, ino: 22 }),
      identityStats({ dev: 99n, ino: 22n }),
      { platform: 'win32', requireVolumeMatch: true, allowMixedHandlePathVolume: true },
    ),
    true,
  );
  assert.throws(
    () => sameFileIdentity(
      identityStats({ dev: 11, ino: 22 }),
      identityStats({ dev: 99n, ino: 22n }),
      {
        platform: 'win32',
        requireVolumeMatch: true,
        allowMixedHandlePathVolume: false,
      },
    ),
    /identity is unsupported on this Windows filesystem/u,
  );
  assert.throws(
    () => sameFileIdentity(
      identityStats({ dev: 11, ino: 22 }),
      identityStats({ dev: 11n, ino: 23n }),
      { platform: 'win32' },
    ),
    /identity is unsupported on this Windows filesystem/u,
  );
  assert.equal(
    samePathIdentity(
      identityStats({ dev: 11, ino: 22 }),
      identityStats({ dev: 11, ino: 22 }),
      { platform: 'win32' },
    ),
    true,
  );
  assert.equal(
    samePathIdentity(
      identityStats({ dev: 11, ino: 22 }),
      identityStats({ dev: 99, ino: 22 }),
      { platform: 'win32' },
    ),
    false,
  );
  assert.throws(
    () => samePathIdentity(
      identityStats({ dev: 0, ino: 22 }),
      identityStats({ dev: 99, ino: 22 }),
      { platform: 'win32' },
    ),
    /identity is unsupported on this Windows filesystem/u,
  );
  assert.throws(
    () => samePathIdentity(
      identityStats({ dev: 0, ino: 22 }),
      identityStats({ dev: 0, ino: 22 }),
      { platform: 'win32' },
    ),
    /identity is unsupported on this Windows filesystem/u,
  );
  assert.equal(
    samePathIdentity(
      identityStats({ dev: 0, ino: 22 }),
      identityStats({ dev: 0, ino: 22 }),
      { platform: 'win32', canonicalVolume: 'C:\\' },
    ),
    true,
  );
  assert.throws(
    () => samePathIdentity(
      identityStats({ dev: 0, ino: 22 }),
      identityStats({ dev: 1, ino: 22 }),
      { platform: 'win32', canonicalVolume: 'C:\\' },
    ),
    /identity is unsupported on this Windows filesystem/u,
  );
  assert.equal(
    samePathIdentity(
      identityStats({ dev: 0, ino: 22 }),
      identityStats({ dev: 0, ino: 22 }),
      {
        platform: 'win32',
        leftCanonicalVolume: 'C:\\',
        rightCanonicalVolume: 'D:\\',
      },
    ),
    false,
  );
  for (const invalid of [
    { dev: 0, ino: 22 },
    { dev: 11, ino: 0 },
    { dev: Number.MAX_SAFE_INTEGER + 1, ino: 22 },
    { dev: 11, ino: Number.MAX_SAFE_INTEGER + 1 },
    { dev: Number.POSITIVE_INFINITY, ino: 22 },
    { dev: 11, ino: 1.5 },
  ]) {
    assert.throws(
      () => sameFileIdentity(
        identityStats(invalid),
        identityStats(invalid),
        { platform: 'win32' },
      ),
      /identity is unsupported on this Windows filesystem/u,
    );
    assert.throws(
      () => samePathIdentity(
        identityStats(invalid),
        identityStats(invalid),
        { platform: 'win32' },
      ),
      /identity is unsupported on this Windows filesystem/u,
    );
  }
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
});

test('Windows state save and load fail closed when handle/path volumes differ', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-handle-volume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  const stateFile = path.join(directory, 'state.json');
  await mkdir(directory, { mode: 0o700 });

  const makeInjectedLstat = (target) => {
    let pathCalls = 0;
    return async (candidate, options) => {
      // Simulated Windows ancestor walks use Win32-shaped paths even though
      // this regression runs with a POSIX temporary directory.
      if (typeof candidate === 'string' && candidate.startsWith('\\')) {
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        };
      }
      // Normalize the baseline before the injected volume mutation. On the
      // hosted Windows Node 22 runner pathname Stats may report dev=0; if the
      // outer seam normalized only after this mutation, 0 -> 1 would collapse
      // back to the same synthetic volume and stop proving rejection.
      const stats = windowsTestStats(await lstat(candidate, options));
      if (candidate !== target) return stats;
      // A Windows file index is volume-scoped. Make the two independent path
      // observations disagree so the path-to-path proof rejects a replacement;
      // handle/path volume divergence itself is a known Windows runtime quirk
      // and is intentionally handled by the caller's allow-mixed option.
      pathCalls += 1;
      if (pathCalls < 2) return stats;
      const replacement = Object.assign(
        Object.create(Object.getPrototypeOf(stats)),
        stats,
      );
      replacement.dev = typeof stats.dev === 'bigint'
        ? stats.dev + 1n
        : stats.dev + 1;
      return replacement;
    };
  };

  await assert.rejects(
    saveState(stateFile, {}, {
      platform: 'win32',
      realpath: async (parentPath) => parentPath,
      lstat: makeInjectedLstat(directory),
    }),
    /parent directory identity changed/u,
  );
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });

  await writeFile(stateFile, '{}\n');
  await assert.rejects(
    loadState(stateFile, {
      platform: 'win32',
      realpath: async (parentPath) => parentPath,
      lstat: makeInjectedLstat(stateFile),
      hardenPermissions: false,
    }),
    /review state file identity changed/u,
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
    sameFileIdentity(handleStats, pathStats, {
      platform: 'win32',
      allowMixedHandlePathVolume: true,
    }),
    true,
  );

  const replacementStats = await lstat(replacementPath, { bigint: true });
  assert.throws(
    () => sameFileIdentity(handleStats, replacementStats, {
      platform: 'win32',
      allowMixedHandlePathVolume: true,
    }),
    /identity is unsupported on this Windows filesystem/u,
  );
});

test('Windows simulated save/load accepts mixed handle and pathname stat types with zero volume', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-mixed-stats-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (process.platform === 'win32') {
    const directoryStats = await lstat(directory, { bigint: true });
    if (!Number.isSafeInteger(Number(directoryStats.ino))) {
      t.skip('Windows runtime file indexes cannot be represented as safe numeric Stats values');
      return;
    }
  }
  const stateFile = path.join(directory, 'state.json');
  const state = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'mixed-stats-sha',
      lastReviewedAt: '2026-08-12T00:00:00.000Z',
    },
  };

  // Model a Windows hosted runner whose descriptor stats use bigint fields
  // while lstat() returns safe numeric fields, including the zero volume
  // reported by Node 22 on some hosted Windows filesystems. Win32-shaped
  // ancestor paths are synthetic because this regression runs on a POSIX host.
  const mixedLstat = async (candidate, options) => {
    if (typeof candidate === 'string' && candidate.startsWith('\\')) {
      return {
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    }
    const stats = windowsTestStats(await lstat(candidate, options));
    const mixed = Object.assign(
      Object.create(Object.getPrototypeOf(stats)),
      stats,
    );
    mixed.dev = 0;
    mixed.ino = Number(stats.ino);
    return mixed;
  };
  const options = {
    platform: 'win32',
    realpath: async (parentPath) => parentPath,
    lstat: mixedLstat,
  };

  await saveState(stateFile, state, options);
  assert.deepEqual(
    await loadState(stateFile, { ...options, hardenPermissions: false }),
    state,
  );
});

test('Windows retention marker truncation leaves valid JSON and failed truncation retains the prior state', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-marker-truncate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const initialState = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-08-12T00:00:00.000Z',
    },
  };
  const replacement = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'new-sha',
      lastReviewedAt: '2026-08-12T01:00:00.000Z',
    },
  };

  await saveState(stateFile, initialState, { platform: 'win32' });
  assert.deepEqual(
    await loadState(stateFile, { platform: 'win32', hardenPermissions: false }),
    initialState,
  );

  const lockPath = path.join(directory, '.openmergelens-retention.lock');
  let failTruncate = true;
  const openWithTruncateFailure = async (...args) => {
    const handle = await open(...args);
    if (args[0] !== lockPath || !failTruncate) return handle;
    failTruncate = false;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === 'truncate') {
          return async () => { throw new Error('sentinel truncate failure'); };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  await assert.rejects(
    saveState(stateFile, replacement, {
      platform: 'win32',
      openFile: openWithTruncateFailure,
    }),
    /sentinel truncate failure/u,
  );
  assert.deepEqual(
    await loadState(stateFile, { platform: 'win32', hardenPermissions: false }),
    initialState,
  );
  const retained = (await readdir(directory)).filter((name) => name.includes('.tmp-'));
  assert.equal(retained.length, 1, 'the failed reservation is retained as one bounded artifact');
  assert.ok(retained.length <= MAX_REVIEW_STATE_TEMPORARIES);

  await saveState(stateFile, replacement, { platform: 'win32' });
  assert.deepEqual(
    await loadState(stateFile, { platform: 'win32', hardenPermissions: false }),
    replacement,
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

test('loading state fails closed when its parent or ancestor is missing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-load-missing-parent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'missing-parent', 'state.json');

  await assert.rejects(loadState(stateFile), { code: 'ENOENT' });
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
  const names = await readdir(directory);
  if (process.platform === 'win32') {
    assert.equal(names.filter((name) => name.includes('.tmp-')).length, 1);
  } else {
    assert.deepEqual(names, ['state.json']);
  }
});

test('Windows retained replacement files are bounded without unsafe scavenging', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const replacement = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  const retainedFailure = /simulated pre-rename failure/u;
  let hardenCalls = 0;
  const saveOptions = {
    platform: 'win32',
    hardenHandle: async () => {
      hardenCalls += 1;
      throw new Error('simulated pre-rename failure');
    },
  };

  for (let attempt = 0; attempt < MAX_REVIEW_STATE_TEMPORARIES; attempt += 1) {
    await assert.rejects(saveState(stateFile, replacement, saveOptions), retainedFailure);
  }

  const temporaryNames = (await readdir(directory))
    .filter((name) => name.includes('.tmp-'));
  assert.equal(temporaryNames.length, MAX_REVIEW_STATE_TEMPORARIES);
  const retainedBytes = await Promise.all(
    temporaryNames.map(async (name) => (await stat(path.join(directory, name))).size),
  );
  assert.equal(
    retainedBytes.reduce((total, size) => total + size, 0) <=
      MAX_REVIEW_STATE_TEMPORARIES * Buffer.byteLength(JSON.stringify(replacement, null, 2) + '\n'),
    true,
  );

  // A generated-looking entry that was not created by this save is never
  // scavenged. The cap check fails before another open can occur, leaving the
  // unverified entry untouched for an operator to inspect or remove safely.
  const unverifiedPath = path.join(
    directory,
    'state.json.tmp-123-12345678-1234-4123-8123-123456789abc',
  );
  await writeFile(unverifiedPath, 'operator evidence\n');
  await assert.rejects(
    saveState(stateFile, replacement, saveOptions),
    /temporary retention limit reached/u,
  );
  assert.equal(hardenCalls, MAX_REVIEW_STATE_TEMPORARIES);
  assert.equal(await readFile(unverifiedPath, 'utf8'), 'operator evidence\n');
  assert.equal(
    (await readdir(directory)).filter((name) => name.includes('.tmp-')).length,
    MAX_REVIEW_STATE_TEMPORARIES + 1,
  );
});

test('concurrent Windows saves reserve temporary capacity atomically', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const replacement = {
    [prKey('owner/repo', 1, reviewer)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  let readdirCalls = 0;
  let releaseFirstRead;
  let firstReadEntered;
  const firstRead = new Promise((resolve) => {
    firstReadEntered = resolve;
  });
  const readGate = new Promise((resolve) => {
    releaseFirstRead = resolve;
  });
  const concurrentReadDirectory = async (...args) => {
    readdirCalls += 1;
    if (readdirCalls === 1) {
      firstReadEntered();
      await readGate;
    }
    return readdir(...args);
  };
  const saveOptions = {
    platform: 'win32',
    readdir: concurrentReadDirectory,
    hardenHandle: async () => {
      throw new Error('simulated pre-rename failure');
    },
  };

  const attempts = Array.from({ length: MAX_REVIEW_STATE_TEMPORARIES + 1 }, () =>
    saveState(stateFile, replacement, saveOptions));
  await firstRead;
  // The first capacity check is held at a barrier. A second concurrent save
  // must not observe the same count: the process queue serializes it behind
  // creation of the first reserved temporary file.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(readdirCalls, 1);
  releaseFirstRead();

  const results = await Promise.allSettled(attempts);
  assert.equal(
    results.filter(({ status, reason }) =>
      status === 'rejected' && /simulated pre-rename failure/u.test(reason.message),
    ).length,
    MAX_REVIEW_STATE_TEMPORARIES,
  );
  assert.equal(
    results.filter(({ status, reason }) =>
      status === 'rejected' && /temporary retention limit reached/u.test(reason.message),
    ).length,
    1,
  );
  assert.equal(
    (await readdir(directory)).filter((name) => name.includes('.tmp-')).length,
    MAX_REVIEW_STATE_TEMPORARIES,
  );
});

test('Windows retention cap uses one parent marker across processes and state files', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-parent-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // Seed all but one reservation with generated-looking retained files. The
  // children race to claim the final slot using different state filenames.
  // A state-file-scoped lock would let both pass this count check.
  for (let index = 0; index < MAX_REVIEW_STATE_TEMPORARIES - 1; index += 1) {
    const suffix = String(index).padStart(12, '0');
    await writeFile(
      path.join(
        directory,
        `seed-${index}.tmp-1-00000000-0000-4000-8000-${suffix}`,
      ),
      'operator evidence\n',
    );
  }

  const [first, second] = await Promise.all([
    runWindowsSaveChild(path.join(directory, 'state-a.json')),
    runWindowsSaveChild(path.join(directory, 'state-b.json')),
  ]);
  const outcomes = [first, second].map(({ code, stderr }) => ({
    code,
    message: (() => {
      try { return JSON.parse(stderr).message; } catch { return stderr; }
    })(),
  }));
  assert.equal(
    outcomes.filter(({ message }) => /child pre-rename failure/u.test(message)).length,
    1,
  );
  assert.equal(
    outcomes.filter(({ message }) => /retention limit reached/u.test(message)).length,
    1,
  );

  const namesAfterRace = await readdir(directory);
  assert.equal(
    namesAfterRace.filter((name) => name.includes('.tmp-')).length,
    MAX_REVIEW_STATE_TEMPORARIES,
  );
  assert.deepEqual(
    namesAfterRace.filter((name) => name === '.openmergelens-retention.lock'),
    ['.openmergelens-retention.lock'],
  );
  assert.equal(
    namesAfterRace.filter((name) => name.includes('.blocked-')).length,
    0,
  );

  // Repeated attempts, including a different state filename, reuse the same
  // bounded marker and never append another evidence artifact.
  await assert.rejects(
    saveState(path.join(directory, 'state-a.json'), {}, { platform: 'win32' }),
    /retention limit reached/u,
  );
  await assert.rejects(
    saveState(path.join(directory, 'state-b.json'), {}, { platform: 'win32' }),
    /retention limit reached/u,
  );
  const namesAfterRetries = await readdir(directory);
  assert.equal(
    namesAfterRetries.filter((name) => name === '.openmergelens-retention.lock').length,
    1,
  );
  assert.equal(
    namesAfterRetries.filter((name) => name.includes('.blocked-')).length,
    0,
  );
});

test('Windows retention recovers an orphan empty lock under the parent guard', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-orphan-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, '.openmergelens-retention.lock');
  await writeFile(lockPath, '');
  const stale = new Date(Date.now() - 60_000);
  await utimes(lockPath, stale, stale);

  let renameCalls = 0;
  await saveState(path.join(directory, 'state.json'), {}, {
      platform: 'win32',
      retentionLockRetryLimit: 2,
      retentionLockRetryDelayMs: 0,
      reserveRename: async (...args) => {
        renameCalls += 1;
        return rename(...args);
      },
    });
  const names = await readdir(directory);
  assert.equal(names.includes('.openmergelens-retention.lock'), false);
  assert.equal(renameCalls >= 1, true, 'orphan lock is reclaimed only after identity binding');
});

test('Windows retention guard survives a crashed owner and requires explicit recovery', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-guard-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const guardPath = path.join(directory, '.openmergelens-retention.guard');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { writeFile } from 'node:fs/promises';
       const guard = process.argv[1];
       await writeFile(guard, JSON.stringify({ version: 1, pid: process.pid, createdAt: Date.now() }) + '\\n', { flag: 'wx' });
       process.stdout.write('ready\\n');`,
      guardPath,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', resolve);
  });
  await new Promise((resolve) => child.once('close', resolve));

  await assert.rejects(
    saveState(path.join(directory, 'state.json'), {}, {
      platform: 'win32',
      retentionLockRetryLimit: 1,
      retentionLockRetryDelayMs: 0,
    }),
    (error) => error.code === 'ERETENTIONGUARDCRASH' && /owner process is no longer live/u.test(error.message),
  );
  assert.equal((await readdir(directory)).includes('.openmergelens-retention.guard'), true);

  // Explicit operator recovery removes only the verified crash marker. A
  // subsequent save proves the bounded outage is recoverable without stale
  // pathname stealing in the library.
  await rm(guardPath);
  const result = await saveState(path.join(directory, 'state.json'), {}, {
    platform: 'win32',
  });
  assert.equal(result.committed, true);
});

for (const guardFailure of [
  {
    name: 'owner stat failure',
    phase: 'owner-stat',
    error: /guard owner stat failure/u,
  },
  {
    name: 'payload open failure',
    phase: 'payload-open',
    error: /guard payload open failure/u,
  },
  {
    name: 'payload stat failure',
    phase: 'payload-stat',
    error: /guard payload stat failure/u,
  },
  {
    name: 'identity failure',
    phase: 'identity',
    error: /guard identity failure/u,
  },
  {
    name: 'owner payload write failure',
    phase: 'write',
    error: /guard owner payload write failure/u,
  },
  {
    name: 'owner payload datasync failure',
    phase: 'datasync',
    error: /guard owner payload datasync failure/u,
  },
  {
    name: 'owner payload short write',
    phase: 'short-write',
    error: /guard owner marker write was short/u,
  },
]) {
  test(`Windows retention guard relocates its inode after ${guardFailure.name}`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-guard-init-failure-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const stateFile = path.join(directory, 'state.json');
    const guardPath = path.join(directory, '.openmergelens-retention.guard');
    let guardOpenCount = 0;
    let failed = false;
    const openWithGuardFailure = async (...args) => {
      const opened = await open(...args);
      if (args[0] !== guardPath || failed) return opened;
      if (guardFailure.phase === 'payload-open' && guardOpenCount === 1) {
        guardOpenCount += 1;
        failed = true;
        await opened.close();
        throw new Error('guard payload open failure');
      }
      guardOpenCount += 1;
      return new Proxy(opened, {
        get(target, property, receiver) {
          const fail = (message) => {
            if (!failed) {
              failed = true;
              throw new Error(message);
            }
            return Reflect.get(target, property, receiver);
          };
          if (guardFailure.phase === 'owner-stat' && property === 'stat') {
            return async (...statArgs) => {
              if (!failed) {
                failed = true;
                throw new Error('guard owner stat failure');
              }
              return target.stat(...statArgs);
            };
          }
          if (guardFailure.phase === 'payload-stat' && guardOpenCount === 2 && property === 'stat') {
            return async () => fail('guard payload stat failure');
          }
          if (guardFailure.phase === 'write' && guardOpenCount === 2 && property === 'write') {
            return async () => fail('guard owner payload write failure');
          }
          if (guardFailure.phase === 'datasync' && guardOpenCount === 2 && property === 'datasync') {
            return async () => fail('guard owner payload datasync failure');
          }
          if (guardFailure.phase === 'short-write' && guardOpenCount === 2 && property === 'write') {
            return async (...writeArgs) => {
              if (!failed) {
                failed = true;
                return { bytesWritten: 0, buffer: undefined };
              }
              return target.write(...writeArgs);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const lstatWithIdentityFailure = async (...args) => {
      if (
        guardFailure.phase === 'identity' &&
        !failed &&
        args[0] === guardPath
      ) {
        failed = true;
        throw new Error('guard identity failure');
      }
      if (process.platform !== 'win32' &&
          typeof args[0] === 'string' && args[0].includes('\\')) {
        return lstat(directory, args[1]);
      }
      return lstat(...args);
    };

    await assert.rejects(
      saveState(stateFile, {}, {
        platform: 'win32',
        openFile: openWithGuardFailure,
        lstat: lstatWithIdentityFailure,
        retentionLockRetryLimit: 1,
        retentionLockRetryDelayMs: 0,
      }),
      guardFailure.error,
    );
    const afterFailure = await readdir(directory);
    assert.equal(afterFailure.includes('.openmergelens-retention.guard'), false);
    assert.equal(
      afterFailure.filter((name) => name.startsWith('state.json.tmp-')).length,
      1,
      'the claimed guard inode is retained under a generated temporary name',
    );

    const result = await saveState(stateFile, {}, { platform: 'win32' });
    assert.equal(result.committed, true);
    assert.equal((await readdir(directory)).includes('state.json'), true);
  });
}

test('Windows retention guard accepts equal-index mixed-volume handle/path bindings', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-guard-volume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const guardPath = path.join(directory, '.openmergelens-retention.guard');
  let guardOpenCount = 0;
  const openWithMixedVolume = async (...args) => {
    const handle = await open(...args);
    if (args[0] !== guardPath || guardOpenCount++ !== 0) return handle;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === 'stat') {
          return async (...statArgs) => {
            const stats = await target.stat(...statArgs);
            const mixed = Object.assign(
              Object.create(Object.getPrototypeOf(stats)),
              stats,
            );
            mixed.dev = typeof stats.dev === 'bigint'
              ? Number(stats.dev) + 1
              : BigInt(stats.dev) + 1n;
            return mixed;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  const result = await saveState(stateFile, {}, {
      platform: 'win32',
      openFile: openWithMixedVolume,
      retentionLockRetryLimit: 1,
      retentionLockRetryDelayMs: 0,
    });
  assert.equal(result.committed, true);
  const names = await readdir(directory);
  assert.equal(names.includes('state.json'), true);
  assert.equal(names.includes('.openmergelens-retention.guard'), false);
});

test('Windows retention lock accepts equal-index mixed-volume handle/path bindings', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-lock-volume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const lockPath = path.join(directory, '.openmergelens-retention.lock');
  let lockOpenCount = 0;
  const openWithMixedVolume = async (...args) => {
    const handle = await open(...args);
    if (args[0] !== lockPath || lockOpenCount++ !== 0) return handle;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === 'stat') {
          return async (...statArgs) => {
            const stats = await target.stat(...statArgs);
            const mixed = Object.assign(
              Object.create(Object.getPrototypeOf(stats)),
              stats,
            );
            mixed.dev = typeof stats.dev === 'bigint'
              ? Number(stats.dev) + 1
              : BigInt(stats.dev) + 1n;
            return mixed;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  const result = await saveState(stateFile, {}, {
      platform: 'win32',
      openFile: openWithMixedVolume,
      retentionLockRetryLimit: 1,
      retentionLockRetryDelayMs: 0,
    });
  assert.equal(result.committed, true);
  const names = await readdir(directory);
  assert.equal(names.includes('state.json'), true);
  assert.equal(names.includes('.openmergelens-retention.lock'), false);
  assert.equal(names.includes('.openmergelens-retention.guard'), false);
});

test('Windows retention guard contenders retry while owner marker initialization is paused', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-guard-init-pause-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const guardPath = path.join(directory, '.openmergelens-retention.guard');
  await writeFile(guardPath, '');
  const contender = saveState(path.join(directory, 'contender-state.json'), {}, {
    platform: 'win32',
    retentionLockRetryLimit: 200,
    retentionLockRetryDelayMs: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Model the owner finishing initialization and releasing its marker. The
  // contender must retry this empty in-progress marker rather than classifying
  // it as a crashed owner.
  await rm(guardPath);
  const result = await contender;
  assert.equal(result.committed, true);
  assert.equal((await readdir(directory)).includes('.openmergelens-retention.guard'), false);
});

test('Windows retention guard treats a live owner observed after initialization as ordinary contention', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-guard-live-after-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const guardPath = path.join(directory, '.openmergelens-retention.guard');
  await writeFile(guardPath, '');
  let transitioned = false;
  const liveMarker = JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: Date.now(),
  }) + '\n';
  const openWithTransition = async (...args) => {
    const opened = await open(...args);
    if (args[0] !== guardPath || transitioned) return opened;
    return new Proxy(opened, {
      get(target, property, receiver) {
        if (property === 'read') {
          return async (...readArgs) => {
            const result = await target.read(...readArgs);
            if (!transitioned && result.bytesRead === 0) {
              transitioned = true;
              await writeFile(guardPath, liveMarker);
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const contender = saveState(path.join(directory, 'contender-state.json'), {}, {
    platform: 'win32',
    openFile: openWithTransition,
    retentionLockRetryLimit: 3,
    retentionLockRetryDelayMs: 0,
  });

  await assert.rejects(
    contender,
    (error) => {
      assert.equal(error.code, undefined);
      assert.match(error.message, /temporary retention guard is unavailable/u);
      assert.doesNotMatch(error.message, /ERETENTIONGUARDCRASH|remove the guard file/u);
      return true;
    },
  );
  assert.match(await readFile(guardPath, 'utf8'), /"pid":/u);
});

for (const marker of [
  { name: 'empty', contents: '' },
  { name: 'partial', contents: '{"version":1,"pid":' },
]) {
  test(`Windows retention guard reports a crashed ${marker.name} initialization after bounded retries`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), `openmergelens-state-win-retention-guard-crashed-${marker.name}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const guardPath = path.join(directory, '.openmergelens-retention.guard');
    await writeFile(guardPath, marker.contents);

    await assert.rejects(
      saveState(path.join(directory, 'state.json'), {}, {
        platform: 'win32',
        retentionLockRetryLimit: 2,
        retentionLockRetryDelayMs: 0,
      }),
      (error) => {
        assert.equal(error.code, 'ERETENTIONGUARDCRASH');
        assert.match(error.message, new RegExp(guardPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(error.message, /remove the guard file/u);
        assert.match(error.message, /initialization did not complete/u);
        return true;
      },
    );
    assert.equal(await readFile(guardPath, 'utf8'), marker.contents);
  });
}

test('Windows retention relocates a claimed marker when owner payload acquisition fails', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-owner-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const lockPath = path.join(directory, '.openmergelens-retention.lock');
  let lockOpens = 0;
  const openWithPayloadFailure = async (...args) => {
    if (args[0] === lockPath) {
      lockOpens += 1;
      if (lockOpens === 2) {
        throw Object.assign(new Error('owner payload open failure'), { code: 'EIO' });
      }
    }
    return open(...args);
  };

  await assert.rejects(
    saveState(stateFile, {}, {
      platform: 'win32',
      openFile: openWithPayloadFailure,
    }),
    /owner payload open failure/u,
  );
  const names = await readdir(directory);
  assert.equal(names.includes('.openmergelens-retention.lock'), false);
  assert.equal(
    names.some((name) => name.startsWith('state.json.tmp-')),
    true,
    'the claimed inode is retained as evidence while releasing the lock pathname',
  );
});

test('Windows retention fails closed on a stale PID even when identity appears mismatched', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-pid-reuse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const lockPath = path.join(directory, '.openmergelens-retention.lock');
  const staleAt = Date.now() - 60_000;
  await writeFile(lockPath, JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: staleAt,
    startIdentity: 'old-process-start',
  }) + '\n');
  const staleDate = new Date(staleAt);
  await utimes(lockPath, staleDate, staleDate);

  let renameCalls = 0;
  await assert.rejects(
    saveState(stateFile, {}, {
      platform: 'win32',
      retentionLockRetryLimit: 1,
      retentionLockRetryDelayMs: 0,
      reserveRename: async (...args) => {
        renameCalls += 1;
        return rename(...args);
      },
    }),
    /owner marker is old but its PID is still live/u,
  );
  assert.equal((await readdir(directory)).includes('.openmergelens-retention.lock'), true);
  assert.equal(renameCalls, 0, 'stale probing must not rename a newer owner pathname');
});

for (const markerFailure of [
  {
    name: 'truncate failure',
    method: 'truncate',
    error: /sentinel truncate failure/u,
  },
  {
    name: 'write failure',
    method: 'write',
    error: /sentinel write failure/u,
  },
  {
    name: 'sync failure',
    method: 'sync',
    error: /sentinel sync failure/u,
  },
  {
    name: 'short write',
    method: 'shortWrite',
    error: /sentinel write was short/u,
  },
]) {
  test(`Windows retention marker recovers after a ${markerFailure.name}`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-marker-recovery-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const stateFile = path.join(directory, 'state.json');
    for (let index = 0; index < MAX_REVIEW_STATE_TEMPORARIES; index += 1) {
      await writeFile(
        path.join(
          directory,
          `seed-${index}.tmp-1-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        ),
        'retained evidence\n',
      );
    }

    let firstCapacityRead = true;
    const readdirWithRetryWindow = async (...args) => {
      if (args[0] === directory && firstCapacityRead) {
        firstCapacityRead = false;
        return readdir(...args);
      }
      if (args[0] === directory) return [];
      return readdir(...args);
    };
    let failureHandlePending = true;
    const openWithMarkerFailure = async (...args) => {
      const handle = await open(...args);
      if (
        !failureHandlePending ||
        typeof args[0] !== 'string' ||
        !args[0].endsWith('.openmergelens-retention.lock')
      ) {
        return handle;
      }
      failureHandlePending = false;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === markerFailure.method) {
            if (property === 'shortWrite') return undefined;
            return async () => {
              throw new Error(`sentinel ${markerFailure.method} failure`);
            };
          }
          if (property === 'write' && markerFailure.method === 'shortWrite') {
            return async () => ({ bytesWritten: 0 });
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    await assert.rejects(
      saveState(stateFile, {}, {
        platform: 'win32',
        readdir: readdirWithRetryWindow,
        openFile: openWithMarkerFailure,
      }),
      (error) => {
        assert.match(error.message, /temporary retention limit reached/u);
        assert.match(error.markerError?.message || '', markerFailure.error);
        return true;
      },
    );

    const markerPath = path.join(directory, '.openmergelens-retention.lock');
    assert.equal((await readdir(directory)).includes('.openmergelens-retention.lock'), false);
    assert.equal(
      (await readdir(directory)).filter((name) => name.includes('.tmp-')).length,
      MAX_REVIEW_STATE_TEMPORARIES + 1,
    );
    const result = await saveState(stateFile, {}, {
      platform: 'win32',
      readdir: readdirWithRetryWindow,
      openFile: openWithMarkerFailure,
    });
    assert.equal(result.committed, true);
    await assert.rejects(lstat(markerPath));
  });
}

for (const failure of [
  {
    name: 'readdir failure',
    option: (directory) => {
      let failed = false;
      return {
        readdir: async (...args) => {
          if (!failed && args[0] === directory) {
            failed = true;
            throw Object.assign(new Error('transient retention listing failure'), {
              code: 'EIO',
            });
          }
          return readdir(...args);
        },
      };
    },
    error: /transient retention listing failure/u,
  },
  {
    name: 'parent identity failure',
    option: (directory) => {
      const lockPath = path.join(directory, '.openmergelens-retention.lock');
      let failed = false;
      return {
        lstat: async (...args) => {
          if (args[0] === directory && !failed) {
            // The parent identity check must fail after the retention lock has
            // been claimed, otherwise there is no reservation inode to move
            // out of the lock pathname and the recovery assertion is testing
            // an earlier setup failure. This condition is stable across the
            // longer Windows ancestor walk on hosted runners.
            try {
              await lstat(lockPath);
            } catch (error) {
              if (error?.code !== 'ENOENT') throw error;
              return lstat(...args);
            }
            failed = true;
            throw Object.assign(new Error('transient retention identity failure'), {
              code: 'EIO',
            });
          }
          // Hosted POSIX paths are used to model the Windows platform. The
          // Windows ancestor walk normalizes them to backslashes; keep that
          // synthetic walk on the same verified directory rather than asking
          // the POSIX filesystem for a literal backslash path.
          if (process.platform !== 'win32' &&
              typeof args[0] === 'string' && args[0].includes('\\')) {
            return lstat(directory, args[1]);
          }
          return lstat(...args);
        },
      };
    },
    error: /transient retention identity failure/u,
  },
  {
    name: 'reservation rename failure',
    option: () => {
      let failed = false;
      return {
        reserveRename: async (...args) => {
          if (!failed) {
            failed = true;
            throw Object.assign(new Error('transient retention rename failure'), {
              code: 'EIO',
            });
          }
          return rename(...args);
        },
      };
    },
    error: /transient retention rename failure/u,
  },
]) {
  test(`Windows retention lock recovers after a transient ${failure.name}`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-recovery-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const stateFile = path.join(directory, 'state.json');
    const options = {
      platform: 'win32',
      ...failure.option(directory),
    };

    await assert.rejects(saveState(stateFile, {}, options), failure.error);
    const afterFailure = await readdir(directory);
    assert.equal(afterFailure.includes('.openmergelens-retention.lock'), false);
    assert.equal(afterFailure.filter((name) => name.includes('.tmp-')).length, 1);

    const result = await saveState(stateFile, {}, options);
    assert.equal(result.committed, true);
    const afterRetry = await readdir(directory);
    assert.equal(afterRetry.includes('state.json'), true);
    assert.equal(afterRetry.includes('.openmergelens-retention.lock'), false);
  });
}

test('Windows retention marker probe rejects an oversized marker without reading its body', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-oversized-marker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await writeFile(
    path.join(directory, '.openmergelens-retention.lock'),
    Buffer.alloc(16 * 1024 * 1024, 0x61),
  );

  await assert.rejects(
    saveState(stateFile, {}, { platform: 'win32' }),
    /retention lock is oversized/u,
  );
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ['.openmergelens-retention.lock'],
  );
});

test('Windows retention marker probe rejects a non-regular marker', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-directory-marker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await mkdir(path.join(directory, '.openmergelens-retention.lock'));

  await assert.rejects(
    saveState(stateFile, {}, { platform: 'win32' }),
    /retention lock must be a regular file/u,
  );
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ['.openmergelens-retention.lock'],
  );
});

test('Windows retention marker probe rejects a no-follow replacement race', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-retention-symlink-marker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const victim = path.join(directory, 'victim.txt');
  await writeFile(victim, 'operator evidence\n');
  await symlink(victim, path.join(directory, '.openmergelens-retention.lock'));

  await assert.rejects(
    saveState(stateFile, {}, { platform: 'win32' }),
    /retention lock is not a safe regular file/u,
  );
  assert.equal(await readFile(victim, 'utf8'), 'operator evidence\n');
  assert.equal(
    (await lstat(path.join(directory, '.openmergelens-retention.lock'))).isSymbolicLink(),
    true,
  );
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
  const names = await readdir(directory);
  if (process.platform === 'win32') {
    assert.equal(names.filter((name) => name.includes('.tmp-')).length, 1);
  } else {
    assert.deepEqual(names, ['state.json']);
  }
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
  const names = await readdir(directory);
  if (process.platform === 'win32') {
    assert.equal(names.filter((name) => name.includes('.tmp-')).length, 1);
  } else {
    assert.deepEqual(names, ['state.json']);
  }
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

test('temporary cleanup failure is surfaced without deleting the previous state', {
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

test('temporary cleanup propagates an injected parent lstat failure', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  await saveState(stateFile, {});

  let failCleanup = false;
  const cleanupFailure = Object.assign(new Error('cleanup parent lstat failed'), {
    code: 'EIO',
  });
  const injectedLstat = async (candidate, options) => {
    if (failCleanup && candidate === directory) throw cleanupFailure;
    return lstat(candidate, options);
  };

  await assert.rejects(
    saveState(stateFile, {}, {
      lstat: injectedLstat,
      commitRename: async () => {
        failCleanup = true;
        throw new Error('simulated commit failure');
      },
    }),
    /simulated commit failure.*temporary cleanup also failed.*cleanup parent lstat failed/u,
  );
});

test('Windows cleanup retains a temporary replacement made after identity checks', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-cleanup-'));
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
  let replacementPath;
  let removeCalls = 0;

  await assert.rejects(
    saveState(stateFile, {}, {
      platform: 'win32',
      beforeCommitRename: async (temporaryPath) => {
        replacementPath = temporaryPath;
        // This runs after the final pathname/descriptor identity checks. A
        // pathname rm in cleanup would therefore delete the replacement.
        await rm(temporaryPath);
        await writeFile(temporaryPath, 'attacker replacement\n');
        throw new Error('simulated commit failure after cleanup substitution');
      },
      removeTemporary: async (temporaryPath) => {
        removeCalls += 1;
        await rm(temporaryPath, { force: true });
      },
    }),
    /simulated commit failure after cleanup substitution.*temporary cleanup also failed.*descriptor-relative cleanup is unavailable/u,
  );

  assert.equal(removeCalls, 0, 'Windows must not pathname-rm after descriptors close');
  assert.equal(await readFile(stateFile, 'utf8'), originalBytes);
  assert.equal(await readFile(replacementPath, 'utf8'), 'attacker replacement\n');
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

test('Windows state save rejects a parent realpath substitution before creating a replacement', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-parent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  const stateFile = path.join(directory, 'state.json');
  await mkdir(directory, { mode: 0o700 });

  let realpathCalls = 0;
  await assert.rejects(
    saveState(stateFile, {}, {
      platform: 'win32',
      realpath: async (parentPath) => {
        realpathCalls += 1;
        return realpathCalls === 1
          ? parentPath
          : path.join(root, 'junction-target');
      },
    }),
    /parent directory realpath changed/u,
  );

  assert.equal(realpathCalls >= 2, true);
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });
});

test('Windows state rejects a canonical ancestor substitution even when its target keeps the same basename', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-junction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  const stateFile = path.join(directory, 'state.json');
  await mkdir(directory, { mode: 0o700 });
  let realpathCalls = 0;

  await assert.rejects(
    saveState(stateFile, {}, {
      platform: 'win32',
      realpath: async (parentPath) => {
        realpathCalls += 1;
        return realpathCalls === 1
          ? parentPath
          : path.join(root, 'attacker-target', 'private');
      },
    }),
    /parent directory realpath changed/u,
  );
  assert.equal(realpathCalls >= 2, true);
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });
});

test('Windows state walks injected ancestor lstat results on non-Windows', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-reparse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  const stateFile = path.join(directory, 'state.json');
  await mkdir(directory, { mode: 0o700 });
  const reparseAncestor = path.win32.normalize(path.win32.resolve(root));
  let walkedAncestor = false;

  const injectedLstat = async (candidate, options) => {
    if (typeof candidate === 'string' && !candidate.startsWith('/')) {
      if (path.win32.normalize(candidate) === reparseAncestor) {
        walkedAncestor = true;
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => true,
        };
      }
      return {
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    }
    return lstat(candidate, options);
  };

  await assert.rejects(
    saveState(stateFile, {}, {
      platform: 'win32',
      realpath: async (parentPath) => parentPath,
      lstat: injectedLstat,
    }),
    /parent directory realpath changed/u,
  );
  assert.equal(walkedAncestor, true);
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });
});

test('Windows state rejects a rechecked parent on another volume with the same file index', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-volume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  const stateFile = path.join(directory, 'state.json');
  await mkdir(directory, { mode: 0o700 });

  let parentLstatCalls = 0;
  let commitCalled = false;
  // On real Windows the reparse-ancestor walk lstat's the parent once during
  // each verification. The initial parent proof also performs one walk, so
  // the direct identity recheck is the fifth parent lstat on Windows. POSIX-
  // hosted simulations have no walk and recheck on the second.
  const identityRecheckCall = process.platform === 'win32' &&
    path.win32.isAbsolute(directory)
    ? 5
    : 2;
  const injectedLstat = async (candidate, options) => {
    // The simulated Windows ancestor walk asks lstat() with Win32-shaped
    // paths even though this regression runs on a POSIX host.
    if (typeof candidate === 'string' && candidate.startsWith('\\')) {
      return {
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    }
    const stats = windowsTestStats(await lstat(candidate, options));
    if (candidate !== directory) return stats;
    parentLstatCalls += 1;
    if (parentLstatCalls !== identityRecheckCall) return stats;
    // Simulate a hosted Windows path/handle report where the file index is
    // equal but the path resolves on another volume. The handle-side `ino`
    // comparison remains valid; path-side volume binding must reject this.
    const replacement = Object.assign(
      Object.create(Object.getPrototypeOf(stats)),
      stats,
    );
    replacement.dev = typeof stats.dev === 'bigint'
      ? stats.dev + 1n
      : stats.dev + 1;
    return replacement;
  };

  await assert.rejects(
    saveState(stateFile, {}, {
      platform: 'win32',
      realpath: async (parentPath) => parentPath,
      lstat: injectedLstat,
      commitRename: async (...args) => {
        commitCalled = true;
        await rename(...args);
      },
    }),
    /parent directory identity changed/u,
  );
  assert.equal(parentLstatCalls >= 2, true);
  assert.equal(commitCalled, false);
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });
});

test('Windows state load rejects a rechecked parent on another volume with the same file index', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-load-volume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  const stateFile = path.join(directory, 'state.json');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(stateFile, '{}\n');

  let parentLstatCalls = 0;
  const injectedLstat = async (candidate, options) => {
    // Simulated Windows ancestor walks use Win32-shaped paths even though
    // this regression runs with a POSIX temporary directory.
    if (typeof candidate === 'string' && candidate.startsWith('\\')) {
      return {
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    }
    const stats = windowsTestStats(await lstat(candidate, options));
    if (candidate !== directory) return stats;
    parentLstatCalls += 1;
    if (parentLstatCalls !== 2) return stats;
    // Keep the file index equal while changing the volume identifier. The
    // path-to-path binding must reject this before state bytes are read.
    const replacement = Object.assign(
      Object.create(Object.getPrototypeOf(stats)),
      stats,
    );
    replacement.dev = typeof stats.dev === 'bigint'
      ? stats.dev + 1n
      : stats.dev + 1;
    return replacement;
  };

  await assert.rejects(
    loadState(stateFile, {
      platform: 'win32',
      realpath: async (parentPath) => parentPath,
      lstat: injectedLstat,
      hardenPermissions: false,
    }),
    /parent directory identity changed/u,
  );
  assert.equal(parentLstatCalls >= 2, true);
});

test('Windows state save rechecks the parent realpath immediately before atomic commit', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-win-parent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private');
  const stateFile = path.join(directory, 'state.json');
  await mkdir(directory, { mode: 0o700 });

  let realpathCalls = 0;
  let commitCalled = false;
  await assert.rejects(
    saveState(stateFile, {}, {
      platform: 'win32',
      realpath: async (parentPath) => {
        realpathCalls += 1;
        return realpathCalls < 3
          ? parentPath
          : path.join(root, 'junction-target');
      },
      commitRename: async () => {
        commitCalled = true;
      },
    }),
    /parent directory realpath changed/u,
  );

  assert.equal(commitCalled, false);
  assert.equal(realpathCalls >= 3, true);
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });
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

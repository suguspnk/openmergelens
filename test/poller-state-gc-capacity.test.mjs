import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAiProcessingConsent } from '../lib/ai-processing-consent.mjs';
import { pollOnce } from '../lib/poller.mjs';
import {
  MAX_REVIEW_STATE_ENTRIES,
  MAX_STATE_GC_CHECKS_PER_POLL,
  MAX_STATE_FILE_BYTES,
} from '../lib/security-limits.mjs';
import {
  prKey,
  serializeState,
  STATE_METADATA_KEY,
} from '../lib/state.mjs';

const account = {
  hostname: 'github.com',
  username: 'work',
  repositories: ['owner/repo'],
};
const validatedSearchResults = new WeakSet();

function completeSearch(candidates) {
  validatedSearchResults.add(candidates);
  return candidates;
}

function padStateNearByteLimit(state, targetBytes) {
  const rows = Array.from({ length: MAX_REVIEW_STATE_ENTRIES }, (_, index) => [
    `${String(index).padStart(5, '0')}-${'\0'.repeat(500)}`,
    index,
  ]);
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    state[STATE_METADATA_KEY] = {
      version: 1,
      candidateCursors: Object.fromEntries(rows.slice(0, middle)),
    };
    const bytes = serializeState(state, {
      enforceByteLimit: false,
    }).serializedBytes;
    if (bytes <= targetBytes) low = middle;
    else high = middle - 1;
  }

  const cursors = Object.fromEntries(rows.slice(0, low));
  let paddingLow = 0;
  let paddingHigh = 498;
  while (paddingLow < paddingHigh) {
    const middle = Math.ceil((paddingLow + paddingHigh) / 2);
    cursors[`z-${'\0'.repeat(middle)}`] = 0;
    state[STATE_METADATA_KEY] = { version: 1, candidateCursors: cursors };
    const bytes = serializeState(state, {
      enforceByteLimit: false,
    }).serializedBytes;
    delete cursors[`z-${'\0'.repeat(middle)}`];
    if (bytes <= targetBytes) paddingLow = middle;
    else paddingHigh = middle - 1;
  }
  if (paddingLow > 0) cursors[`z-${'\0'.repeat(paddingLow)}`] = 0;
  state[STATE_METADATA_KEY] = { version: 1, candidateCursors: cursors };
  return serializeState(state).serializedBytes;
}

function capacityState(entryCount, { stateAccount, repo, shaFor }) {
  return Object.fromEntries(
    Array.from({ length: entryCount }, (_, index) => [
      prKey(repo, index + 1, stateAccount),
      {
        lastReviewedSha: shaFor(index + 1),
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    ]),
  );
}

function proofDependencies() {
  return {
    createGitHubMutationQueue: () => ({
      run: async (operation) => operation(),
    }),
    createGitHubMutationCadence: () => ({
      run: async (operation, { beforeStart } = {}) => {
        if (beforeStart) await beforeStart();
        return operation();
      },
    }),
    resolveGitHubAuth: async (candidateAccount) => ({
      ...candidateAccount,
      token: `${candidateAccount.username}-token`,
    }),
    currentUsername: async ({ auth }) => auth.username,
    isValidatedReviewRequestSearchResult: (candidates) =>
      validatedSearchResults.has(candidates),
    searchReviewRequestedPRs: async () => completeSearch([]),
    getPullRequest: async ({ repo, number }) => ({
      headRefOid: 'target-sha',
      number,
      title: 'Target PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    }),
    getPullRequestForStateGc: async ({ repo, number }) => ({
      headRefOid: `old-${number}`,
      number,
      title: 'Historical PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    }),
    getPullRequestDiff: async () => '@@ -0,0 +1 @@\n+line\n',
    hasActiveReviewRequest: async () => true,
    reviewAlreadyPosted: async () => false,
    ensureReviewPrompt: async () => '/virtual/prompt.md',
    readPrompt: async () => '{{diff}}',
    readLearnings: async () => '',
    invokeMultiPassReview: async () => ({ summary: 'reviewed', findings: [] }),
    postReview: async ({ scheduleMutation }) => scheduleMutation(async () => {}),
    now: () => Date.parse('2026-08-12T00:00:00.000Z'),
  };
}

function proofPollOptions(root, accounts, dependencies) {
  return {
    config: {
      configVersion: 5,
      githubAccounts: accounts,
      aiProcessingConsent: createAiProcessingConsent('reviewer', accounts),
      reviewerCommand: 'reviewer',
      model: null,
      reviewerInputMode: 'stdin',
      reviewBatchSize: 2,
      reviewFocusCount: 1,
      stateFile: './state.json',
    },
    stateFile: path.join(root, 'state.json'),
    logPath: path.join(root, 'poll.log'),
    defaultReviewPromptPath: path.join(root, 'template.md'),
    logger: {
      child() { return this; },
      info() {},
      warn() {},
      error() {},
      output() {},
    },
    dependencies,
  };
}

test('byte-ceiling proof rotation reaches an exact victim without metadata growth', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const donorRepo = `owner/${'d'.repeat(100)}`;
  const donor = {
    hostname: 'github.com',
    username: 'long-donor-account-name',
    repositories: [donorRepo],
  };
  const target = {
    hostname: 'github.com',
    username: 'p',
    repositories: ['o/r'],
  };
  const state = capacityState(MAX_REVIEW_STATE_ENTRIES, {
    stateAccount: donor,
    repo: donorRepo,
    shaFor: () => '\0'.repeat(128),
  });
  const initialBytes = padStateNearByteLimit(state, MAX_STATE_FILE_BYTES - 5);
  assert.ok(initialBytes >= MAX_STATE_FILE_BYTES - 10);
  const proofCalls = [];
  let persistedState;
  const dependencies = proofDependencies();
  dependencies.loadState = async () => state;
  dependencies.saveState = async (_path, nextState) => {
    serializeState(nextState);
    persistedState = structuredClone(nextState);
  };
  dependencies.searchReviewRequestedPRs = async ({ repo }) => completeSearch(
    repo === 'o/r' ? [{ repo, number: 1 }] : [],
  );
  dependencies.reviewAlreadyPosted = async ({ repo, number }) => {
    if (repo === donorRepo) proofCalls.push(number);
    return repo === donorRepo && number === 1;
  };

  const result = await pollOnce(proofPollOptions(
    root,
    [donor, target],
    dependencies,
  ));

  assert.equal(result.failed, false);
  assert.deepEqual(proofCalls, [1]);
  assert.equal(persistedState[prKey(donorRepo, 1, donor)], undefined);
  assert.equal(persistedState[prKey('o/r', 1, target)].lastReviewedSha, 'target-sha');
  assert.ok(serializeState(persistedState).serializedBytes <= MAX_STATE_FILE_BYTES);
});

test('byte-ceiling unsuccessful proofs persist one bounded queue rotation batch', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const donorRepo = `owner/${'d'.repeat(100)}`;
  const donor = {
    hostname: 'github.com',
    username: 'long-donor-account-name',
    repositories: [donorRepo],
  };
  const target = {
    hostname: 'github.com',
    username: 'p',
    repositories: ['o/r'],
  };
  const state = capacityState(MAX_REVIEW_STATE_ENTRIES, {
    stateAccount: donor,
    repo: donorRepo,
    shaFor: () => '\0'.repeat(128),
  });
  const initialBytes = padStateNearByteLimit(state, MAX_STATE_FILE_BYTES - 5);
  assert.ok(initialBytes >= MAX_STATE_FILE_BYTES - 10);
  let proofCalls = 0;
  let closureCalls = 0;
  const writtenBytes = [];
  const dependencies = proofDependencies();
  dependencies.loadState = async () => state;
  dependencies.saveState = async (_path, nextState) => {
    writtenBytes.push(serializeState(nextState).serializedBytes);
  };
  dependencies.searchReviewRequestedPRs = async ({ repo }) => completeSearch(
    repo === 'o/r' ? [{ repo, number: 1 }] : [],
  );
  dependencies.reviewAlreadyPosted = async ({ repo }) => {
    if (repo === donorRepo) proofCalls += 1;
    return false;
  };
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => {
    closureCalls += 1;
    return {
      headRefOid: `old-${number}`,
      number,
      title: 'Historical PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };

  const result = await pollOnce(proofPollOptions(
    root,
    [donor, target],
    dependencies,
  ));

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'review state capacity reached');
  assert.equal(proofCalls, MAX_STATE_GC_CHECKS_PER_POLL - 1);
  assert.equal(closureCalls, 1);
  assert.deepEqual(writtenBytes, [initialBytes, initialBytes]);
});

function legacyOverCapState({ expired = false, malformed = false } = {}) {
  return Object.fromEntries(
    Array.from({ length: MAX_REVIEW_STATE_ENTRIES + 1 }, (_, index) => [
      prKey('owner/repo', index + 1, account),
      {
        lastReviewedSha: index === 0 && malformed ? '' : `sha-${index + 1}`,
        lastReviewedAt: index === 0 && expired
          ? '2025-08-12T00:00:00.000Z'
          : '2026-08-11T00:00:00.000Z',
      },
    ]),
  );
}

test('legacy over-cap state reclaims only remotely confirmed closed entries', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = legacyOverCapState();
  await writeFile(stateFile, JSON.stringify(initialState));
  const checked = [];
  const closedKey = Object.keys(initialState).sort()[0];
  const authCalls = { count: 0 };
  const dependencies = migrationDependencies({ authCalls });
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => {
    const key = prKey(repo, number, account);
    checked.push(key);
    return {
      headRefOid: `sha-${number}`,
      number,
      title: 'Tracked PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: key === closedKey ? 'CLOSED' : 'OPEN',
    };
  };

  const result = await pollOnce(migrationPollOptions(root, dependencies));

  assert.equal(result.failed, false);
  assert.equal(authCalls.count, 1);
  assert.equal(checked[0], closedKey);
  assert.equal(checked.length, MAX_STATE_GC_CHECKS_PER_POLL + 1);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(persisted[closedKey], undefined);
  assert.equal(
    Object.keys(persisted).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
});

function migrationDependencies({ authCalls, saveState } = {}) {
  return {
    createGitHubMutationQueue: () => ({
      run: async (operation) => operation(),
    }),
    createGitHubMutationCadence: () => ({
      run: async (operation, { beforeStart } = {}) => {
        if (beforeStart) await beforeStart();
        return operation();
      },
    }),
    resolveGitHubAuth: async () => {
      if (authCalls) authCalls.count += 1;
      return { username: account.username };
    },
    currentUsername: async ({ auth }) => auth.username,
    isValidatedReviewRequestSearchResult: (candidates) =>
      validatedSearchResults.has(candidates),
    searchReviewRequestedPRs: async () => completeSearch([]),
    getPullRequestForStateGc: async ({ repo, number }) => ({
      headRefOid: `sha-${number}`,
      number,
      title: 'Tracked PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    }),
    now: () => Date.parse('2026-08-12T00:00:00.000Z'),
    ...(saveState ? { saveState } : {}),
  };
}

function migrationPollOptions(root, dependencies) {
  return {
    config: {
      configVersion: 5,
      githubAccounts: [account],
      aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
      reviewerCommand: 'reviewer',
      model: null,
      reviewerInputMode: 'stdin',
      reviewBatchSize: 1,
      reviewFocusCount: 1,
      stateFile: './state.json',
    },
    stateFile: path.join(root, 'state.json'),
    logPath: path.join(root, 'poll.log'),
    defaultReviewPromptPath: path.join(root, 'template.md'),
    logger: {
      child() { return this; },
      info() {},
      warn() {},
      error() {},
      output() {},
    },
    dependencies,
  };
}

test('legacy over-cap state atomically expires enough entries before authentication', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = legacyOverCapState({ expired: true });
  initialState['owner/repo#10002'] = {
    lastReviewedSha: 'expired-unscoped',
    lastReviewedAt: '2025-08-12T00:00:00.000Z',
  };
  await writeFile(stateFile, JSON.stringify(initialState));
  const authCalls = { count: 0 };

  const result = await pollOnce(migrationPollOptions(
    root,
    migrationDependencies({ authCalls }),
  ));

  assert.equal(result.failed, false);
  assert.equal(authCalls.count, 1);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(persisted[prKey('owner/repo', 1, account)], undefined);
  assert.equal(persisted['owner/repo#10002'], undefined);
  assert.equal(
    Object.keys(persisted).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
});

test('active legacy over-cap state fails closed after bounded authenticated checks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = legacyOverCapState();
  const serialized = JSON.stringify(initialState);
  await writeFile(stateFile, serialized);
  const authCalls = { count: 0 };
  let closureChecks = 0;
  const dependencies = migrationDependencies({ authCalls });
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => {
    closureChecks += 1;
    return {
      headRefOid: `sha-${number}`,
      number,
      title: 'Tracked PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };

  const result = await pollOnce(migrationPollOptions(
    root,
    dependencies,
  ));

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'legacy state capacity migration required');
  assert.equal(authCalls.count, 1);
  assert.equal(closureChecks, 1_000);
  assert.equal(await readFile(stateFile, 'utf8'), serialized);
});

test('malformed legacy over-cap state fails validation before authentication', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = legacyOverCapState({ expired: true, malformed: true });
  const serialized = JSON.stringify(initialState);
  await writeFile(stateFile, serialized);
  const authCalls = { count: 0 };

  await assert.rejects(
    pollOnce(migrationPollOptions(
      root,
      migrationDependencies({ authCalls }),
    )),
    /Invalid review state entry/u,
  );
  assert.equal(authCalls.count, 0);
  assert.equal(await readFile(stateFile, 'utf8'), serialized);
});

test('legacy over-cap expiry rolls back when its atomic save fails', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = legacyOverCapState({ expired: true });
  const serialized = JSON.stringify(initialState);
  await writeFile(stateFile, serialized);
  const authCalls = { count: 0 };

  const result = await pollOnce(migrationPollOptions(
    root,
    migrationDependencies({
      authCalls,
      saveState: async () => { throw new Error('disk full'); },
    }),
  ));

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'legacy state capacity migration failed');
  assert.equal(authCalls.count, 0);
  assert.equal(await readFile(stateFile, 'utf8'), serialized);
});

test('near-byte-ceiling closure GC persists byte-neutral progress across polls', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-gc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialState = Object.fromEntries(
    Array.from({ length: 60 }, (_, index) => [
      prKey('owner/repo', index + 1, account),
      {
        lastReviewedSha: `sha-${index + 1}`,
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    ]),
  );
  const initialBytes = padStateNearByteLimit(
    initialState,
    MAX_STATE_FILE_BYTES - 5,
  );
  const expectedKeys = Object.keys(initialState)
    .filter((key) => key !== STATE_METADATA_KEY)
    .sort();
  let persistedState = structuredClone(initialState);
  const checked = [];
  const writtenBytes = [];
  const silentLogger = {
    child() { return this; },
    info() {},
    warn() {},
    error() {},
    output() {},
  };
  const config = {
    configVersion: 5,
    githubAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer',
    model: null,
    reviewerInputMode: 'stdin',
    reviewBatchSize: 1,
    reviewFocusCount: 1,
    stateFile: './state.json',
  };

  async function runSweep() {
    const dependencies = {
      createGitHubMutationQueue: () => ({
        run: async (operation) => operation(),
      }),
      createGitHubMutationCadence: () => ({
        run: async (operation, { beforeStart } = {}) => {
          if (beforeStart) await beforeStart();
          return operation();
        },
      }),
      resolveGitHubAuth: async () => ({ username: account.username }),
      currentUsername: async ({ auth }) => auth.username,
      isValidatedReviewRequestSearchResult: (candidates) =>
        validatedSearchResults.has(candidates),
      searchReviewRequestedPRs: async () => completeSearch([]),
      getPullRequestForStateGc: async ({ repo, number }) => {
        checked.push(prKey(repo, number, account));
        return {
          headRefOid: `sha-${number}`,
          number,
          title: 'Tracked PR',
          url: `https://github.com/${repo}/pull/${number}`,
          body: '',
          state: 'OPEN',
        };
      },
      loadState: async () => structuredClone(persistedState),
      saveState: async (_path, nextState) => {
        const { serializedBytes } = serializeState(nextState);
        writtenBytes.push(serializedBytes);
        persistedState = structuredClone(nextState);
      },
    };
    return pollOnce({
      config,
      stateFile: path.join(root, 'state.json'),
      logPath: path.join(root, 'poll.log'),
      defaultReviewPromptPath: path.join(root, 'template.md'),
      logger: silentLogger,
      dependencies,
    });
  }

  assert.ok(initialBytes >= MAX_STATE_FILE_BYTES - 10);
  const first = await runSweep();
  assert.equal(first.failed, false);
  assert.deepEqual(
    checked,
    expectedKeys.slice(0, MAX_STATE_GC_CHECKS_PER_POLL),
  );

  const second = await runSweep();
  assert.equal(second.failed, false);
  assert.deepEqual(
    checked.slice(MAX_STATE_GC_CHECKS_PER_POLL),
    expectedKeys.slice(
      MAX_STATE_GC_CHECKS_PER_POLL,
      MAX_STATE_GC_CHECKS_PER_POLL * 2,
    ),
  );
  assert.deepEqual(writtenBytes, [initialBytes, initialBytes]);
});

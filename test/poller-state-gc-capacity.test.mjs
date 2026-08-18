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
      enforceEntryLimit: false,
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
      enforceEntryLimit: false,
      enforceByteLimit: false,
    }).serializedBytes;
    delete cursors[`z-${'\0'.repeat(middle)}`];
    if (bytes <= targetBytes) paddingLow = middle;
    else paddingHigh = middle - 1;
  }
  if (paddingLow > 0) cursors[`z-${'\0'.repeat(paddingLow)}`] = 0;
  state[STATE_METADATA_KEY] = { version: 1, candidateCursors: cursors };
  return serializeState(state, {
    enforceEntryLimit: false,
  }).serializedBytes;
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

test('legacy over-cap repair adopts an unscoped marker before discovery', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const targetNumber = MAX_REVIEW_STATE_ENTRIES + 1;
  const targetKey = `owner/repo#${targetNumber}`;
  const scopedTargetKey = prKey('owner/repo', targetNumber, account);
  const initialState = Object.fromEntries(
    Array.from({ length: MAX_REVIEW_STATE_ENTRIES }, (_, index) => [
      prKey('owner/repo', index + 1, account),
      {
        lastReviewedSha: `sha-${index + 1}`,
        lastReviewedAt: '2026-08-11T00:00:00.000Z',
      },
    ]),
  );
  initialState[targetKey] = {
    lastReviewedSha: 'target-sha',
    lastReviewedAt: '2026-08-11T00:00:00.000Z',
    reviewMarkerVersion: 1,
  };
  await writeFile(stateFile, JSON.stringify(initialState));
  const closedKey = prKey('owner/repo', 1, account);
  let reviewerCalls = 0;
  let postCalls = 0;
  let reconciliationCalls = 0;
  const dependencies = migrationDependencies();
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => ({
    headRefOid: `sha-${number}`,
    number,
    title: 'Tracked PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: prKey(repo, number, account) === closedKey ? 'CLOSED' : 'OPEN',
  });
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    { repo: 'owner/repo', number: targetNumber },
  ]);
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'target-sha',
    number,
    title: 'Requested PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  dependencies.reviewAlreadyPosted = async () => {
    reconciliationCalls += 1;
    return false;
  };
  dependencies.invokeMultiPassReview = async () => {
    reviewerCalls += 1;
    return { summary: 'reviewed', findings: [] };
  };
  dependencies.postReview = async () => {
    postCalls += 1;
  };

  const result = await pollOnce(migrationPollOptions(root, dependencies));

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.equal(reviewerCalls, 0);
  assert.equal(postCalls, 0);
  assert.equal(reconciliationCalls, 0);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(persisted[closedKey], undefined);
  assert.equal(persisted[targetKey], undefined);
  assert.deepEqual(persisted[scopedTargetKey], initialState[targetKey]);
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

test('active legacy over-cap state rotates one bounded authenticated window', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = legacyOverCapState();
  await writeFile(stateFile, JSON.stringify(initialState));
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
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  const persistedKeys = Object.keys(persisted)
    .filter((key) => key !== STATE_METADATA_KEY);
  assert.equal(persistedKeys.length, MAX_REVIEW_STATE_ENTRIES + 1);
  assert.equal(persistedKeys[0], prKey('owner/repo', 1_001, account));
  for (const key of Object.keys(initialState)) assert.ok(persisted[key]);
});

test('legacy over-cap repair bounds systemic lookup failures and rotates them', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = legacyOverCapState();
  await writeFile(stateFile, JSON.stringify(initialState));
  const timeouts = [];
  const dependencies = migrationDependencies();
  dependencies.monotonicNow = () => 0;
  dependencies.getPullRequestForStateGc = async ({ timeoutMs }) => {
    timeouts.push(timeoutMs);
    throw new Error('systemic transport failure');
  };

  const result = await pollOnce(migrationPollOptions(root, dependencies));

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'legacy state capacity migration required');
  assert.deepEqual(timeouts, [5_000, 5_000, 5_000]);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  const persistedKeys = Object.keys(persisted)
    .filter((key) => key !== STATE_METADATA_KEY);
  assert.equal(persistedKeys.length, MAX_REVIEW_STATE_ENTRIES + 1);
  assert.equal(persistedKeys[0], prKey('owner/repo', 4, account));
  for (const key of Object.keys(initialState)) assert.ok(persisted[key]);
});

test('legacy over-cap repair counts unsupported PR states as failures', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  await writeFile(stateFile, JSON.stringify(legacyOverCapState()));
  let checks = 0;
  const dependencies = migrationDependencies();
  dependencies.monotonicNow = () => 0;
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => {
    checks += 1;
    return {
      headRefOid: `sha-${number}`,
      number,
      title: 'Tracked PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'BROKEN',
    };
  };

  const result = await pollOnce(migrationPollOptions(root, dependencies));

  assert.equal(result.failed, true);
  assert.equal(checks, 3);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(Object.keys(persisted)[0], prKey('owner/repo', 4, account));
});

test('legacy repair deadline bounds authentication and ignores unrelated accounts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  await writeFile(stateFile, JSON.stringify(legacyOverCapState()));
  const unrelated = {
    hostname: 'github.com',
    username: 'other',
    repositories: ['other/repo'],
  };
  const calls = [];
  const dependencies = migrationDependencies();
  dependencies.monotonicNow = () => 0;
  dependencies.resolveGitHubAuth = async (candidate, { timeoutMs }) => {
    calls.push({ kind: 'token', username: candidate.username, timeoutMs });
    return { ...candidate, token: 'token' };
  };
  dependencies.currentUsername = async ({ auth, timeoutMs }) => {
    calls.push({ kind: 'user', username: auth.username, timeoutMs });
    return auth.username;
  };
  const options = migrationPollOptions(root, dependencies);
  options.config.githubAccounts.push(unrelated);
  options.config.aiProcessingConsent = createAiProcessingConsent(
    'reviewer',
    options.config.githubAccounts,
  );

  const result = await pollOnce(options);

  assert.equal(result.failed, true);
  assert.deepEqual(calls.slice(0, 2), [
    { kind: 'token', username: 'work', timeoutMs: 5_000 },
    { kind: 'user', username: 'work', timeoutMs: 5_000 },
  ]);
  assert.equal(calls.some((call) => call.username === 'other'), false);
});

test('legacy repair persists a completed auth batch when the next deadline gate closes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const migrationAccounts = Array.from({ length: 6 }, (_, index) => ({
    hostname: 'github.com',
    username: `work-${index + 1}`,
    repositories: [`owner/repo-${index + 1}`],
  }));
  const entriesPerAccount = [1_667, 1_667, 1_667, 1_667, 1_667, 1_666];
  const state = {};
  for (const [accountIndex, candidateAccount] of migrationAccounts.entries()) {
    for (let index = 0; index < entriesPerAccount[accountIndex]; index += 1) {
      state[prKey(
        candidateAccount.repositories[0],
        index + 1,
        candidateAccount,
      )] = {
        lastReviewedSha: `sha-${accountIndex + 1}-${index + 1}`,
        lastReviewedAt: '2026-08-11T00:00:00.000Z',
      };
    }
  }
  await writeFile(stateFile, JSON.stringify(state));
  const authenticatedUsernames = [];
  let clockCalls = 0;
  const dependencies = migrationDependencies();
  dependencies.monotonicNow = () => {
    clockCalls += 1;
    return clockCalls <= 7 ? 0 : 15_000;
  };
  dependencies.resolveGitHubAuth = async (candidateAccount) => {
    authenticatedUsernames.push(candidateAccount.username);
    throw new Error('simulated authentication timeout');
  };
  const options = migrationPollOptions(root, dependencies);
  options.config.githubAccounts = migrationAccounts;
  options.config.aiProcessingConsent = createAiProcessingConsent(
    'reviewer',
    migrationAccounts,
  );

  const first = await pollOnce(options);
  assert.equal(first.failed, true);
  assert.deepEqual(authenticatedUsernames, [
    'work-1',
    'work-2',
    'work-3',
    'work-4',
    'work-5',
  ]);

  authenticatedUsernames.length = 0;
  clockCalls = 0;
  const second = await pollOnce(options);
  assert.equal(second.failed, true);
  assert.equal(authenticatedUsernames[0], 'work-6');
});

test('legacy auth rotation handles a byte-valid six-figure predecessor state', {
  timeout: 15_000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const migrationAccounts = Array.from({ length: 6 }, (_, index) => ({
    hostname: 'github.com',
    username: String.fromCharCode('a'.charCodeAt(0) + index),
    repositories: [`o/${String.fromCharCode('a'.charCodeAt(0) + index)}`],
  }));
  const firstAccount = migrationAccounts[0];
  const entryCount = 110_001;
  const state = Object.fromEntries(
    Array.from({ length: entryCount }, (_, index) => [
      prKey('o/a', index + 1, firstAccount),
      {
        lastReviewedSha: 's',
        lastReviewedAt: '2026-08-11T00:00:00.000Z',
      },
    ]),
  );
  for (const laterAccount of migrationAccounts.slice(1)) {
    state[prKey(laterAccount.repositories[0], 1, laterAccount)] = {
      lastReviewedSha: 's',
      lastReviewedAt: '2026-08-11T00:00:00.000Z',
    };
  }
  const serialized = JSON.stringify(state);
  assert.ok(Buffer.byteLength(serialized) < MAX_STATE_FILE_BYTES);
  await writeFile(stateFile, serialized);
  let clockCalls = 0;
  const attemptedAccounts = [];
  const dependencies = migrationDependencies();
  dependencies.monotonicNow = () => {
    clockCalls += 1;
    return clockCalls <= 7 ? 0 : 15_000;
  };
  dependencies.resolveGitHubAuth = async (candidateAccount) => {
    attemptedAccounts.push(candidateAccount.username);
    throw new Error('simulated authentication timeout');
  };
  const options = migrationPollOptions(root, dependencies);
  options.config.githubAccounts = migrationAccounts;
  options.config.aiProcessingConsent = createAiProcessingConsent(
    'reviewer',
    options.config.githubAccounts,
  );

  const result = await pollOnce(options);

  assert.equal(result.failed, true);
  assert.deepEqual(attemptedAccounts, ['a', 'b', 'c', 'd', 'e']);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(Object.keys(persisted).length, entryCount + 5);
  assert.equal(
    Object.keys(persisted)[0],
    prKey('o/f', 1, migrationAccounts[5]),
  );
});

test('legacy over-cap repair stops at its wall-clock deadline', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  await writeFile(stateFile, JSON.stringify(legacyOverCapState()));
  const checks = [];
  const dependencies = migrationDependencies();
  let migrationClockCalls = 0;
  dependencies.monotonicNow = () => {
    migrationClockCalls += 1;
    if (migrationClockCalls <= 5) return 0;
    if (migrationClockCalls === 6) return 14_999;
    return 15_000;
  };
  dependencies.getPullRequestForStateGc = async ({ number, timeoutMs }) => {
    checks.push({ number, timeoutMs });
    return {
      headRefOid: `sha-${number}`,
      number,
      title: 'Tracked PR',
      url: `https://github.com/owner/repo/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };

  const result = await pollOnce(migrationPollOptions(root, dependencies));

  assert.equal(result.failed, true);
  assert.deepEqual(checks, [{ number: 1, timeoutMs: 1 }]);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(Object.keys(persisted)[0], prKey('owner/repo', 2, account));
});

test('legacy over-cap deadline also aborts a queued authentication wait', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  await writeFile(stateFile, JSON.stringify(legacyOverCapState()));
  const dependencies = migrationDependencies();
  let migrationClockCalls = 0;
  dependencies.monotonicNow = () => {
    migrationClockCalls += 1;
    return migrationClockCalls <= 2 ? 0 : 14_999;
  };
  let remoteCalls = 0;
  dependencies.getPullRequestForStateGc = async () => {
    remoteCalls += 1;
    throw new Error('must remain queued');
  };
  dependencies.createGitHubMutationQueue = () => ({
    run: async (operation, { signal } = {}) => {
      if (!signal) return operation();
      await new Promise((resolve, reject) => {
        const keepAlive = setInterval(() => {}, 10);
        signal.addEventListener('abort', () => {
          clearInterval(keepAlive);
          reject(signal.reason);
        }, { once: true });
      });
    },
  });

  const result = await pollOnce(migrationPollOptions(root, dependencies));

  assert.equal(result.failed, true);
  assert.equal(remoteCalls, 0);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(Object.keys(persisted)[0], prKey('owner/repo', 1, account));
});

test('oversized predecessor state reaches bounded capacity repair', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = legacyOverCapState();
  const raw = JSON.stringify(initialState) + ' '.repeat(MAX_STATE_FILE_BYTES);
  assert.ok(Buffer.byteLength(raw) > MAX_STATE_FILE_BYTES);
  await writeFile(stateFile, raw);
  const dependencies = migrationDependencies();
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => ({
    headRefOid: `sha-${number}`,
    number,
    title: 'Tracked PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: number === 1 ? 'CLOSED' : 'OPEN',
  });

  const result = await pollOnce(migrationPollOptions(root, dependencies));

  assert.equal(result.failed, false);
  const repairedBytes = await readFile(stateFile);
  assert.ok(repairedBytes.byteLength < MAX_STATE_FILE_BYTES);
  const repaired = JSON.parse(repairedBytes.toString('utf8'));
  assert.equal(repaired[prKey('owner/repo', 1, account)], undefined);
  assert.equal(
    Object.keys(repaired).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
});

test('many closed entries near the legacy byte ceiling use incremental repair projection', {
  timeout: 5_000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const entryCount = MAX_REVIEW_STATE_ENTRIES + 501;
  const initialState = Object.fromEntries(
    Array.from({ length: entryCount }, (_, index) => [
      prKey('owner/repo', index + 1, account),
      {
        lastReviewedSha: `sha-${index + 1}`,
        lastReviewedAt: '2026-08-11T00:00:00.000Z',
      },
    ]),
  );
  padStateNearByteLimit(initialState, MAX_STATE_FILE_BYTES);
  const serialized = serializeState(initialState, {
    enforceEntryLimit: false,
    enforceByteLimit: false,
  }).serialized;
  assert.ok(Buffer.byteLength(serialized) <= MAX_STATE_FILE_BYTES);
  await writeFile(stateFile, serialized);
  let closureChecks = 0;
  const dependencies = migrationDependencies();
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => {
    closureChecks += 1;
    return {
      headRefOid: `sha-${number}`,
      number,
      title: 'Tracked PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'CLOSED',
    };
  };

  const result = await pollOnce(migrationPollOptions(root, dependencies));

  assert.equal(result.failed, false);
  assert.ok(closureChecks > 501);
  assert.ok(closureChecks <= 1_000);
  const repaired = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(
    Object.keys(repaired).filter((key) => key !== STATE_METADATA_KEY).length,
    entryCount - closureChecks,
  );
  assert.ok(entryCount - closureChecks <= MAX_REVIEW_STATE_ENTRIES);
});

test('legacy over-cap repair accumulates closed entries across windows', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = legacyOverCapState();
  initialState[prKey('owner/repo', MAX_REVIEW_STATE_ENTRIES + 2, account)] = {
    lastReviewedSha: `sha-${MAX_REVIEW_STATE_ENTRIES + 2}`,
    lastReviewedAt: '2026-08-11T00:00:00.000Z',
  };
  await writeFile(stateFile, JSON.stringify(initialState));
  const firstClosedKey = prKey('owner/repo', 1, account);
  const laterClosedKey = prKey('owner/repo', 1_001, account);
  const closedKeys = new Set([firstClosedKey, laterClosedKey]);
  const checked = [];
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
      state: closedKeys.has(key) ? 'CLOSED' : 'OPEN',
    };
  };

  const first = await pollOnce(migrationPollOptions(root, dependencies));
  assert.equal(first.failed, true);
  assert.equal(checked.length, 1_000);
  assert.ok(!checked.includes(laterClosedKey));
  const rotated = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(rotated[firstClosedKey], undefined);
  assert.equal(Object.keys(rotated)[0], laterClosedKey);
  assert.equal(Object.keys(rotated).length, MAX_REVIEW_STATE_ENTRIES + 1);

  const second = await pollOnce(migrationPollOptions(root, dependencies));
  assert.equal(second.failed, false);
  assert.equal(authCalls.count, 2);
  assert.equal(checked[1_000], laterClosedKey);
  const repaired = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(repaired[firstClosedKey], undefined);
  assert.equal(repaired[laterClosedKey], undefined);
  assert.equal(
    Object.keys(repaired).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
});

test('legacy over-cap repair adopts and checks an all-unscoped state', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = Object.fromEntries(
    Array.from({ length: MAX_REVIEW_STATE_ENTRIES + 1 }, (_, index) => [
      `owner/repo#${index + 1}`,
      {
        lastReviewedSha: `sha-${index + 1}`,
        lastReviewedAt: '2026-08-11T00:00:00.000Z',
      },
    ]),
  );
  await writeFile(stateFile, JSON.stringify(initialState));
  const checked = [];
  const authCalls = { count: 0 };
  const dependencies = migrationDependencies({ authCalls });
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => {
    checked.push(prKey(repo, number, account));
    return {
      headRefOid: `sha-${number}`,
      number,
      title: 'Tracked PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: number === 1 ? 'CLOSED' : 'OPEN',
    };
  };

  const result = await pollOnce(migrationPollOptions(root, dependencies));

  assert.equal(result.failed, false);
  assert.equal(authCalls.count, 1);
  assert.equal(checked[0], prKey('owner/repo', 1, account));
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(persisted['owner/repo#1'], undefined);
  assert.equal(persisted[prKey('owner/repo', 1, account)], undefined);
  assert.equal(
    Object.keys(persisted).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
  for (const key of Object.keys(persisted)) {
    if (key === STATE_METADATA_KEY) continue;
    assert.match(key, /^github\.com@work::owner\/repo#[1-9][0-9]*$/u);
  }
});

test('legacy over-cap repair performs no authenticated work without consent', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = legacyOverCapState();
  const serialized = JSON.stringify(initialState);
  await writeFile(stateFile, serialized);
  const authCalls = { count: 0 };
  let githubCalls = 0;
  let searchCalls = 0;
  const dependencies = migrationDependencies({ authCalls });
  dependencies.getPullRequestForStateGc = async () => {
    githubCalls += 1;
    throw new Error('must not run');
  };
  dependencies.searchReviewRequestedPRs = async () => {
    searchCalls += 1;
    return completeSearch([]);
  };
  const options = migrationPollOptions(root, dependencies);
  options.config.aiProcessingConsent = null;

  const result = await pollOnce(options);

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'legacy state capacity migration required');
  assert.equal(authCalls.count, 0);
  assert.equal(githubCalls, 0);
  assert.equal(searchCalls, 0);
  assert.equal(await readFile(stateFile, 'utf8'), serialized);
});

test('legacy over-cap repair progress rolls back when its save fails', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const initialState = legacyOverCapState();
  initialState[prKey('owner/repo', MAX_REVIEW_STATE_ENTRIES + 2, account)] = {
    lastReviewedSha: `sha-${MAX_REVIEW_STATE_ENTRIES + 2}`,
    lastReviewedAt: '2026-08-11T00:00:00.000Z',
  };
  const serialized = JSON.stringify(initialState);
  await writeFile(stateFile, serialized);
  let saveOptions;
  const dependencies = migrationDependencies({
    saveState: async (_path, _state, options) => {
      saveOptions = options;
      throw new Error('disk full');
    },
  });
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => ({
    headRefOid: `sha-${number}`,
    number,
    title: 'Tracked PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: number === 1 ? 'CLOSED' : 'OPEN',
  });

  const result = await pollOnce(migrationPollOptions(root, dependencies));

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'legacy state capacity migration failed');
  assert.deepEqual(saveOptions, { allowEntryLimitMigration: true });
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
  initialState[prKey('owner/repo', 2, account)].lastReviewedAt =
    '2025-08-12T00:00:00.000Z';
  initialState[`owner/repo#${MAX_REVIEW_STATE_ENTRIES + 2}`] = {
    lastReviewedSha: 'legacy-marker-sha',
    lastReviewedAt: '2026-08-11T00:00:00.000Z',
    reviewMarkerVersion: 1,
  };
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

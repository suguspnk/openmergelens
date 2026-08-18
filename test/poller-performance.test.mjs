import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAiProcessingConsent } from '../lib/ai-processing-consent.mjs';
import { pollOnce } from '../lib/poller.mjs';
import {
  MAX_CONFIGURED_REVIEW_SCOPES,
  MAX_REVIEW_STATE_ENTRIES,
} from '../lib/security-limits.mjs';
import {
  prKey,
  reviewStateGcAfterKey,
  STATE_METADATA_KEY,
} from '../lib/state.mjs';

const validatedSearchResults = new WeakSet();

function completeSearch(candidates) {
  Object.defineProperty(candidates, 'complete', { value: true });
  validatedSearchResults.add(candidates);
  return candidates;
}

test('maximum-cardinality reclaim completes within a practical linear-scan budget', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-poller-performance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositories = Array.from(
    { length: MAX_CONFIGURED_REVIEW_SCOPES },
    (_, index) => `owner/repo-${index}`,
  );
  const account = {
    hostname: 'github.com',
    username: 'work',
    repositories,
  };
  const state = Object.fromEntries(repositories.map((repo) => [
    prKey(repo, 1, account),
    {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
      reviewMarkerVersion: 1,
    },
  ]));
  let lastSaved;
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
    searchReviewRequestedPRs: async ({ repo }) => completeSearch(
      repo === repositories[0] ? [{ repo, number: 2 }] : [],
    ),
    getPullRequest: async ({ repo, number }) => ({
      headRefOid: 'target-sha',
      number,
      title: 'Target PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    }),
    getPullRequestForStateGc: async ({ repo, number }) => ({
      headRefOid: 'old-sha',
      number,
      title: 'Tracked PR',
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
    loadState: async () => state,
    saveState: async (_stateFile, nextState) => {
      lastSaved = structuredClone(nextState);
    },
  };
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

  const startedAt = performance.now();
  const result = await pollOnce({
    config,
    stateFile: path.join(root, 'state.json'),
    logPath: path.join(root, 'poll.log'),
    defaultReviewPromptPath: path.join(root, 'template.md'),
    logger: silentLogger,
    dependencies,
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.failed, false);
  assert.ok(
    elapsedMs < 5_000,
    `maximum-cardinality admission took ${elapsedMs.toFixed(1)}ms`,
  );
  assert.equal(lastSaved[prKey(repositories[0], 1, account)], undefined);
  assert.equal(
    lastSaved[prKey(repositories[0], 2, account)].lastReviewedSha,
    'target-sha',
  );
  assert.equal(
    Object.keys(lastSaved).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
});

test('failed new-key reservations leave safety capacity for an existing-key re-review', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-poller-capacity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unavailable = {
    hostname: 'github.com',
    username: 'retired',
    repositories: ['owner/unavailable'],
  };
  const selected = {
    hostname: 'github.com',
    username: 'work',
    repositories: ['owner/selected'],
  };
  const existingKey = prKey('owner/selected', 1, selected);
  const state = Object.fromEntries([
    ...Array.from({ length: MAX_REVIEW_STATE_ENTRIES - 1 }, (_, index) => [
      prKey('owner/unavailable', index + 1, unavailable),
      {
        lastReviewedSha: `old-${index + 1}`,
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    ]),
    [
      existingKey,
      {
        lastReviewedSha: 'previous-sha',
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    ],
  ]);
  const candidates = [
    ...Array.from({ length: 20 }, (_, index) => ({
      repo: 'owner/selected',
      number: index + 2,
    })),
    { repo: 'owner/selected', number: 1 },
  ];
  const reviewed = [];
  const posted = [];
  let persistedState;
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
    resolveGitHubAuth: async () => ({ username: selected.username }),
    currentUsername: async ({ auth }) => auth.username,
    isValidatedReviewRequestSearchResult: (results) =>
      validatedSearchResults.has(results),
    searchReviewRequestedPRs: async () => completeSearch(candidates),
    getPullRequest: async ({ repo, number }) => ({
      headRefOid: `new-sha-${number}`,
      number,
      title: `PR ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    }),
    getPullRequestForStateGc: async ({ repo, number }) => ({
      headRefOid: `new-sha-${number}`,
      number,
      title: `PR ${number}`,
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
    invokeMultiPassReview: async ({ pr }) => {
      reviewed.push(pr.number);
      return { summary: 'reviewed', findings: [] };
    },
    postReview: async ({ number, scheduleMutation }) =>
      scheduleMutation(async () => { posted.push(number); }),
    loadState: async () => state,
    saveState: async (_stateFile, nextState) => {
      persistedState = structuredClone(nextState);
    },
  };
  const silentLogger = {
    child() { return this; },
    info() {},
    warn() {},
    error() {},
    output() {},
  };
  const config = {
    configVersion: 5,
    githubAccounts: [selected],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [selected]),
    reviewerCommand: 'reviewer',
    model: null,
    reviewerInputMode: 'stdin',
    reviewBatchSize: 1,
    reviewFocusCount: 1,
    stateFile: './state.json',
  };

  const result = await pollOnce({
    config,
    stateFile: path.join(root, 'state.json'),
    logPath: path.join(root, 'poll.log'),
    defaultReviewPromptPath: path.join(root, 'template.md'),
    logger: silentLogger,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 1);
  assert.equal(
    result.failures.filter(({ note }) => note === 'review state capacity reached').length,
    20,
  );
  assert.deepEqual(reviewed, [1]);
  assert.deepEqual(posted, [1]);
  assert.equal(
    result.outcomes.find(({ number }) => number === 1)?.status,
    're-reviewed',
  );
  assert.equal(
    result.failures.some(({ subject }) => subject === 'review queue'),
    false,
  );
  assert.equal(persistedState[existingKey].lastReviewedSha, 'new-sha-1');
  assert.equal(
    Object.keys(persistedState).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
});

test('concurrent failed reservations do not transiently defer an existing-key re-review', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-poller-capacity-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unavailable = {
    hostname: 'github.com',
    username: 'retired',
    repositories: ['owner/unavailable'],
  };
  const selected = {
    hostname: 'github.com',
    username: 'work',
    repositories: ['owner/selected'],
  };
  const existingNumbers = Array.from({ length: 19 }, (_, index) => index + 1);
  const state = Object.fromEntries([
    ...Array.from(
      { length: MAX_REVIEW_STATE_ENTRIES - existingNumbers.length },
      (_, index) => [
        prKey('owner/unavailable', index + 1, unavailable),
        {
          lastReviewedSha: `old-unavailable-${index + 1}`,
          lastReviewedAt: '2026-08-05T00:00:00.000Z',
        },
      ],
    ),
    ...existingNumbers.map((number) => [
      prKey('owner/selected', number, selected),
      {
        lastReviewedSha: `old-selected-${number}`,
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    ]),
  ]);
  const failedNewNumbers = [20, 21];
  const targetNumber = 19;
  const candidates = [
    ...existingNumbers.slice(0, -1).map((number) => ({
      repo: 'owner/selected',
      number,
    })),
    ...failedNewNumbers.map((number) => ({ repo: 'owner/selected', number })),
    { repo: 'owner/selected', number: targetNumber },
  ];
  const reviewed = [];
  const posted = [];
  let persistedState;
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
    resolveGitHubAuth: async () => ({ username: selected.username }),
    currentUsername: async ({ auth }) => auth.username,
    isValidatedReviewRequestSearchResult: (results) =>
      validatedSearchResults.has(results),
    searchReviewRequestedPRs: async () => completeSearch(candidates),
    getPullRequest: async ({ repo, number }) => ({
      headRefOid: `new-sha-${number}`,
      number,
      title: `PR ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    }),
    getPullRequestForStateGc: async ({ repo, number }) => ({
      headRefOid: `new-sha-${number}`,
      number,
      title: `PR ${number}`,
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
    invokeMultiPassReview: async ({ pr }) => {
      reviewed.push(pr.number);
      return { summary: 'reviewed', findings: [] };
    },
    postReview: async ({ number, scheduleMutation }) =>
      scheduleMutation(async () => { posted.push(number); }),
    loadState: async () => state,
    saveState: async (_stateFile, nextState) => {
      persistedState = structuredClone(nextState);
    },
  };
  const silentLogger = {
    child() { return this; },
    info() {},
    warn() {},
    error() {},
    output() {},
  };
  const config = {
    configVersion: 5,
    githubAccounts: [selected],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [selected]),
    reviewerCommand: 'reviewer',
    model: null,
    reviewerInputMode: 'stdin',
    reviewBatchSize: 3,
    reviewFocusCount: 1,
    stateFile: './state.json',
  };

  const result = await pollOnce({
    config,
    stateFile: path.join(root, 'state.json'),
    logPath: path.join(root, 'poll.log'),
    defaultReviewPromptPath: path.join(root, 'template.md'),
    logger: silentLogger,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, existingNumbers.length);
  assert.equal(
    result.failures.filter(({ note }) => note === 'review state capacity reached').length,
    failedNewNumbers.length,
  );
  assert.equal(
    result.failures.some(({ subject }) => subject === 'review queue'),
    false,
  );
  assert.deepEqual(reviewed, existingNumbers);
  assert.deepEqual(posted, existingNumbers);
  assert.equal(
    result.outcomes.find(({ number }) => number === targetNumber)?.status,
    're-reviewed',
  );
  assert.equal(
    persistedState[prKey('owner/selected', targetNumber, selected)].lastReviewedSha,
    `new-sha-${targetNumber}`,
  );
  assert.equal(
    Object.keys(persistedState).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
});

test('slow marker proof does not hold global admission across accounts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-poller-proof-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const donor = {
    hostname: 'github.com',
    username: 'work',
    repositories: ['owner/donor'],
  };
  const target = {
    hostname: 'github.com',
    username: 'personal',
    repositories: ['other/target'],
  };
  const targetKey = prKey('other/target', 1, target);
  let persistedState = Object.fromEntries([
    ...Array.from({ length: MAX_REVIEW_STATE_ENTRIES - 1 }, (_, index) => [
      prKey('owner/donor', index + 1, donor),
      {
        lastReviewedSha: `old-${index + 1}`,
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    ]),
    [targetKey, {
      lastReviewedSha: 'old-target',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    }],
  ]);
  let announceProofStart;
  const proofStarted = new Promise((resolve) => { announceProofStart = resolve; });
  let releaseProof;
  const proofGate = new Promise((resolve) => { releaseProof = resolve; });
  let firstProof = true;
  let announceTargetReview;
  const targetReviewStarted = new Promise((resolve) => {
    announceTargetReview = resolve;
  });
  const reviewed = [];
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
    resolveGitHubAuth: async (account) => ({ username: account.username }),
    currentUsername: async ({ auth }) => auth.username,
    isValidatedReviewRequestSearchResult: (results) =>
      validatedSearchResults.has(results),
    searchReviewRequestedPRs: async ({ repo }) => completeSearch([
      { repo, number: repo === 'owner/donor' ? MAX_REVIEW_STATE_ENTRIES : 1 },
    ]),
    getPullRequest: async ({ repo, number }) => ({
      headRefOid: repo === 'owner/donor' ? 'new-donor' : 'new-target',
      number,
      title: 'PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    }),
    getPullRequestForStateGc: async ({ repo, number }) => ({
      headRefOid: `old-${number}`,
      number,
      title: 'Tracked PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    }),
    getPullRequestDiff: async () => '@@ -0,0 +1 @@\n+line\n',
    hasActiveReviewRequest: async () => true,
    reviewAlreadyPosted: async ({ repo, number }) => {
      if (repo === 'owner/donor' && number < MAX_REVIEW_STATE_ENTRIES && firstProof) {
        firstProof = false;
        announceProofStart();
        await proofGate;
      }
      return false;
    },
    ensureReviewPrompt: async () => '/virtual/prompt.md',
    readPrompt: async () => '{{diff}}',
    readLearnings: async () => '',
    invokeMultiPassReview: async ({ pr }) => {
      reviewed.push(pr.number);
      if (pr.headRefOid === 'new-target') announceTargetReview();
      return { summary: 'reviewed', findings: [] };
    },
    postReview: async ({ scheduleMutation }) => scheduleMutation(async () => {}),
    loadState: async () => structuredClone(persistedState),
    saveState: async (_stateFile, nextState) => {
      persistedState = structuredClone(nextState);
    },
  };
  const silentLogger = {
    child() { return this; },
    info() {},
    warn() {},
    error() {},
    output() {},
  };
  const config = {
    configVersion: 5,
    githubAccounts: [donor, target],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [donor, target]),
    reviewerCommand: 'reviewer',
    model: null,
    reviewerInputMode: 'stdin',
    reviewBatchSize: 2,
    reviewFocusCount: 1,
    stateFile: './state.json',
  };

  const poll = pollOnce({
    config,
    stateFile: path.join(root, 'state.json'),
    logPath: path.join(root, 'poll.log'),
    defaultReviewPromptPath: path.join(root, 'template.md'),
    logger: silentLogger,
    dependencies,
  });
  await proofStarted;
  const targetProgressedWhileProofPending = await Promise.race([
    targetReviewStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  releaseProof();
  const result = await poll;

  assert.equal(targetProgressedWhileProofPending, true);
  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 1);
  assert.deepEqual(reviewed, [1]);
  assert.equal(persistedState[targetKey].lastReviewedSha, 'new-target');
});

test('marker-proof cursor rotates across skewed unequal-pressure donor scopes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-poller-proof-fairness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const account = {
    hostname: 'github.com',
    username: 'work',
    repositories: ['owner/a', 'owner/b', 'owner/target'],
  };
  const donorEntries = (repo, count, firstNumber) => Array.from(
    { length: count },
    (_, index) => [
      prKey(repo, firstNumber + index, account),
      {
        lastReviewedSha: `old-${firstNumber + index}`,
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    ],
  );
  let persistedState = Object.fromEntries([
    ...donorEntries('owner/a', 5_001, 100),
    ...donorEntries('owner/b', 4_999, 1),
  ]);
  const donorAKeys = Object.keys(persistedState)
    .filter((key) => key.startsWith('github.com@work::owner/a#'));
  const donorBKeys = Object.keys(persistedState)
    .filter((key) => key.startsWith('github.com@work::owner/b#'));
  const exactProofKey = donorBKeys[12];
  const exactProofNumber = parseInt(
    exactProofKey.slice(exactProofKey.lastIndexOf('#') + 1),
    10,
  );
  const proofCalls = [];
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

  function dependenciesForPoll() {
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
      resolveGitHubAuth: async () => ({ username: account.username }),
      currentUsername: async ({ auth }) => auth.username,
      isValidatedReviewRequestSearchResult: (results) =>
        validatedSearchResults.has(results),
      searchReviewRequestedPRs: async ({ repo }) => completeSearch(
        repo === 'owner/target' ? [{ repo, number: 1 }] : [],
      ),
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
        title: 'Tracked PR',
        url: `https://github.com/${repo}/pull/${number}`,
        body: '',
        state: 'OPEN',
      }),
      getPullRequestDiff: async () => '@@ -0,0 +1 @@\n+line\n',
      hasActiveReviewRequest: async () => true,
      reviewAlreadyPosted: async ({ repo, number }) => {
        if (repo === 'owner/target') return false;
        proofCalls.push(prKey(repo, number, account));
        return repo === 'owner/b' && number === exactProofNumber;
      },
      ensureReviewPrompt: async () => '/virtual/prompt.md',
      readPrompt: async () => '{{diff}}',
      readLearnings: async () => '',
      invokeMultiPassReview: async () => ({ summary: 'reviewed', findings: [] }),
      postReview: async ({ scheduleMutation }) => scheduleMutation(async () => {}),
      loadState: async () => structuredClone(persistedState),
      saveState: async (_stateFile, nextState) => {
        persistedState = structuredClone(nextState);
      },
    };
  }

  async function runPoll() {
    return pollOnce({
      config,
      stateFile: path.join(root, 'state.json'),
      logPath: path.join(root, 'poll.log'),
      defaultReviewPromptPath: path.join(root, 'template.md'),
      logger: silentLogger,
      dependencies: dependenciesForPoll(),
    });
  }

  const first = await runPoll();
  assert.equal(first.failed, true);
  assert.equal(first.reviewed, 0);
  assert.equal(first.failures[0].note, 'review state capacity reached');
  assert.deepEqual(
    proofCalls,
    donorAKeys.slice(0, 12).flatMap((key, index) => [key, donorBKeys[index]]),
  );
  assert.equal(
    Object.keys(persistedState).find((key) => key !== STATE_METADATA_KEY),
    donorAKeys[12],
  );
  for (const key of [...donorAKeys, ...donorBKeys]) assert.ok(persistedState[key]);

  const second = await runPoll();
  assert.equal(second.failed, false);
  assert.equal(second.reviewed, 1);
  assert.deepEqual(proofCalls.slice(24), [donorAKeys[12], exactProofKey]);
  assert.equal(persistedState[exactProofKey], undefined);
  assert.equal(
    persistedState[prKey('owner/target', 1, account)].lastReviewedSha,
    'target-sha',
  );
  assert.equal(
    Object.keys(persistedState).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
});

test('marker-proof cursor reaches a later exact proof on the next poll without starving closure GC', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-poller-proof-cursor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const donor = {
    hostname: 'github.com',
    username: 'work',
    repositories: ['owner/repo'],
  };
  const target = {
    hostname: 'github.com',
    username: 'personal',
    repositories: ['other/repo'],
  };
  let persistedState = Object.fromEntries(
    Array.from({ length: MAX_REVIEW_STATE_ENTRIES }, (_, index) => [
      prKey('owner/repo', index + 1, donor),
      {
        lastReviewedSha: `old-${index + 1}`,
        lastReviewedAt: new Date(
          Date.parse('2026-08-05T00:00:00.000Z') +
          (MAX_REVIEW_STATE_ENTRIES - index) * 1_000,
        ).toISOString(),
      },
    ]),
  );
  const proofOrder = Object.keys(persistedState);
  const closureOrder = [...proofOrder].sort();
  const exactProofKey = proofOrder[25];
  const exactProofNumber = Number(
    exactProofKey.slice(exactProofKey.lastIndexOf('#') + 1),
  );
  const proofCalls = [];
  const gcCalls = [];
  const silentLogger = {
    child() { return this; },
    info() {},
    warn() {},
    error() {},
    output() {},
  };
  const config = {
    configVersion: 5,
    githubAccounts: [donor, target],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [donor, target]),
    reviewerCommand: 'reviewer',
    model: null,
    reviewerInputMode: 'stdin',
    reviewBatchSize: 1,
    reviewFocusCount: 1,
    stateFile: './state.json',
  };

  function dependenciesForPoll() {
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
      resolveGitHubAuth: async (account) => ({ username: account.username }),
      currentUsername: async ({ auth }) => auth.username,
      isValidatedReviewRequestSearchResult: (results) =>
        validatedSearchResults.has(results),
      searchReviewRequestedPRs: async ({ repo }) => completeSearch(
        repo === 'other/repo' ? [{ repo, number: 1 }] : [],
      ),
      getPullRequest: async ({ repo, number }) => ({
        headRefOid: 'target-sha',
        number,
        title: 'Target PR',
        url: `https://github.com/${repo}/pull/${number}`,
        body: '',
        state: 'OPEN',
      }),
      getPullRequestForStateGc: async ({ repo, number }) => {
        gcCalls.push(prKey(repo, number, donor));
        return {
          headRefOid: `sha-${number}`,
          number,
          title: 'Tracked PR',
          url: `https://github.com/${repo}/pull/${number}`,
          body: '',
          state: 'OPEN',
        };
      },
      getPullRequestDiff: async () => '@@ -0,0 +1 @@\n+line\n',
      hasActiveReviewRequest: async () => true,
      reviewAlreadyPosted: async ({ repo, number }) => {
        if (repo !== 'owner/repo') return false;
        const key = prKey(repo, number, donor);
        proofCalls.push(key);
        if (key === proofOrder[0]) throw new Error('HTTP 404: Not Found');
        return number === exactProofNumber;
      },
      ensureReviewPrompt: async () => '/virtual/prompt.md',
      readPrompt: async () => '{{diff}}',
      readLearnings: async () => '',
      invokeMultiPassReview: async () => ({ summary: 'reviewed', findings: [] }),
      postReview: async ({ scheduleMutation }) => scheduleMutation(async () => {}),
      loadState: async () => structuredClone(persistedState),
      saveState: async (_stateFile, nextState) => {
        persistedState = structuredClone(nextState);
      },
    };
  }

  async function runPoll() {
    return pollOnce({
      config,
      stateFile: path.join(root, 'state.json'),
      logPath: path.join(root, 'poll.log'),
      defaultReviewPromptPath: path.join(root, 'template.md'),
      logger: silentLogger,
      dependencies: dependenciesForPoll(),
    });
  }

  const first = await runPoll();
  assert.equal(first.failed, true);
  assert.equal(first.failures[0].note, 'review state capacity reached');
  assert.deepEqual(proofCalls, proofOrder.slice(0, 24));
  assert.equal(
    Object.keys(persistedState).find((key) => key !== STATE_METADATA_KEY),
    proofOrder[24],
  );
  assert.equal(reviewStateGcAfterKey(persistedState), closureOrder[0]);
  assert.deepEqual(gcCalls, [closureOrder[0]]);
  for (const key of proofOrder) assert.ok(persistedState[key]);

  const second = await runPoll();
  assert.equal(second.failed, false);
  assert.deepEqual(proofCalls.slice(24), proofOrder.slice(24, 26));
  assert.equal(persistedState[exactProofKey], undefined);
  assert.equal(
    persistedState[prKey('other/repo', 1, target)].lastReviewedSha,
    'target-sha',
  );
  assert.equal(gcCalls[1], closureOrder[1]);
  assert.equal(reviewStateGcAfterKey(persistedState), gcCalls.at(-1));
  assert.ok(gcCalls.length > 1);
});

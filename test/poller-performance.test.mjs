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
import { prKey, STATE_METADATA_KEY } from '../lib/state.mjs';

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

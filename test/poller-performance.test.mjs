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

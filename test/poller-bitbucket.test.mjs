import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CANDIDATE_METADATA_PER_POLL,
  pollOnce,
} from '../lib/poller.mjs';
import { createAiProcessingConsent } from '../lib/ai-processing-consent.mjs';
import {
  bitbucketReviewAlreadyPosted,
  postBitbucketReview,
} from '../lib/bitbucket.mjs';
import {
  BITBUCKET_POSTING_PLAN_UNREQUESTED_TTL_MS,
  bitbucketPostingPlanFor,
  bitbucketTerminalHeadFor,
  prKey,
  recordBitbucketPostingPlan,
  STATE_METADATA_KEY,
} from '../lib/state.mjs';

const account = {
  hostname: 'bitbucket.org',
  accountId: '{123e4567-e89b-42d3-a456-426614174000}',
  credentialUsername: 'reviewer@example.com',
  repositories: ['workspace/repo'],
};

test('Bitbucket dry run reviews assigned PRs without mutation, state write, or reviewer credentials', async () => {
  let posts = 0;
  let stateWrites = 0;
  const reviewerEnvironments = [];
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer',
    model: null,
    reviewBatchSize: 1,
    reviewFocusCount: 1,
    reviewTimeoutMs: 60_000,
  };
  const result = await pollOnce({
    config,
    stateFile: '/unused/state.json',
    defaultReviewPromptPath: '/unused/template.md',
    dryRun: true,
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies: {
      createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
      createGitHubMutationCadence: () => ({
        run: async (operation, { beforeStart } = {}) => {
          await beforeStart?.();
          return operation();
        },
      }),
      resolveBitbucketAuth: async () => ({
        ...account, username: account.credentialUsername, password: 'provider-secret',
      }),
      searchBitbucketReviewRequestedPRs: async () => [{ repo: 'workspace/repo', number: 7 }],
      getBitbucketPullRequest: async () => ({
        headRefOid: 'abc', number: 7, title: 'PR', body: '', state: 'OPEN',
        url: 'https://bitbucket.org/workspace/repo/pull-requests/7',
      }),
      getBitbucketPullRequestDiff: async () => '+++ b/a.js\n@@ -0,0 +1 @@\n+line\n',
      bitbucketReviewAlreadyPosted: async () => false,
      createBitbucketReviewMarker: () => '<!-- marker -->',
      ensureReviewPrompt: async () => '/virtual/prompt.md',
      readPrompt: async () => '{{diff}}',
      readLearnings: async () => '',
      invokeMultiPassReview: async ({ environment, githubAccess, providerDiff }) => {
        reviewerEnvironments.push(environment);
        assert.equal(githubAccess, undefined);
        assert.match(providerDiff, /\+line/u);
        return { summary: 'Summary', findings: [] };
      },
      prepareBitbucketReview: () => ({ anchorable: [], unanchorable: [] }),
      postBitbucketReview: async () => { posts += 1; },
      reviewerSourceEnvironment: {
        PATH: '/usr/bin',
        GH_TOKEN: 'ambient-github-secret',
        GITHUB_TOKEN: 'ambient-github-secret-2',
        GH_ENTERPRISE_TOKEN: 'ambient-enterprise-secret',
        OPENMERGELENS_GITHUB_ACCOUNT: 'work@github.com',
      },
      loadState: async () => ({}),
      saveState: async () => { stateWrites += 1; },
    },
  });
  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(result.outcomes[0].status, 'dry-run');
  assert.equal(posts, 0);
  assert.equal(stateWrites, 0);
  assert.equal(reviewerEnvironments[0].BITBUCKET_TOKEN, undefined);
  assert.equal(reviewerEnvironments[0].BITBUCKET_PASSWORD, undefined);
  assert.equal(reviewerEnvironments[0].GH_TOKEN, undefined);
  assert.equal(reviewerEnvironments[0].GITHUB_TOKEN, undefined);
  assert.equal(reviewerEnvironments[0].GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(reviewerEnvironments[0].OPENMERGELENS_GITHUB_ACCOUNT, undefined);
  assert.equal(Object.values(reviewerEnvironments[0]).includes('provider-secret'), false);
});

test('Bitbucket revalidates the head at the mutation boundary and does not persist stale reviews', async () => {
  let metadataReads = 0;
  let mutations = 0;
  let stateWrites = 0;
  let savedState;
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer', model: null, reviewBatchSize: 1,
    reviewFocusCount: 1, reviewTimeoutMs: 60_000,
  };
  const result = await pollOnce({
    config, stateFile: '/unused/state.json', defaultReviewPromptPath: '/unused/template.md',
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies: {
      createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
      createGitHubMutationCadence: () => ({
        run: async (operation, { beforeStart }) => { await beforeStart(); return operation(); },
      }),
      resolveBitbucketAuth: async () => ({ ...account, username: account.credentialUsername, password: 'secret' }),
      searchBitbucketReviewRequestedPRs: async () => [{ repo: 'workspace/repo', number: 7 }],
      getBitbucketPullRequest: async () => {
        metadataReads += 1;
        return {
          headRefOid: metadataReads >= 3 ? 'new-head' : 'reviewed-head',
          number: 7, title: 'PR', body: '', state: 'OPEN',
          url: 'https://bitbucket.org/workspace/repo/pull-requests/7',
        };
      },
      getBitbucketPullRequestDiff: async () => '+++ b/a.js\n@@ -0,0 +1 @@\n+line\n',
      bitbucketReviewAlreadyPosted: async () => false,
      createBitbucketReviewMarker: () => '<!-- marker -->',
      ensureReviewPrompt: async () => '/virtual/prompt.md', readPrompt: async () => '{{diff}}',
      readLearnings: async () => '',
      invokeMultiPassReview: async () => ({ summary: 'Summary', findings: [] }),
      postBitbucketReview: async ({ scheduleMutation }) => scheduleMutation(async () => { mutations += 1; }),
      loadState: async () => ({}),
      saveState: async (_path, state) => {
        stateWrites += 1;
        savedState = structuredClone(state);
      },
    },
  });
  assert.equal(result.outcomes[0].status, 'deferred');
  assert.equal(mutations, 0);
  assert.equal(stateWrites, 1);
  assert.equal(
    Object.keys(savedState).filter((key) => key !== STATE_METADATA_KEY).length,
    0,
  );
});

test('Bitbucket tracked changed heads do not review when the reviewer is no longer requested', async () => {
  let reviewerCalls = 0;
  let posterCalls = 0;
  let diffCalls = 0;
  const key = prKey('workspace/repo', 7, account);
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer', model: null, reviewBatchSize: 1,
    reviewFocusCount: 1, reviewTimeoutMs: 60_000,
  };
  const result = await pollOnce({
    config, stateFile: '/unused/state.json', defaultReviewPromptPath: '/unused/template.md',
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies: {
      createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
      createGitHubMutationCadence: () => ({ run: (operation) => operation() }),
      resolveBitbucketAuth: async () => ({
        ...account, username: account.credentialUsername, password: 'secret',
      }),
      searchBitbucketReviewRequestedPRs: async () => [],
      getBitbucketPullRequest: async () => ({
        headRefOid: 'changed-head', number: 7, title: 'PR', body: '', state: 'OPEN',
        url: 'https://bitbucket.org/workspace/repo/pull-requests/7',
      }),
      bitbucketReviewAlreadyPosted: async () => false,
      getBitbucketPullRequestDiff: async () => { diffCalls += 1; return ''; },
      invokeMultiPassReview: async () => { reviewerCalls += 1; return {}; },
      postBitbucketReview: async () => { posterCalls += 1; },
      loadState: async () => ({
        [key]: {
          lastReviewedSha: 'old-head',
          lastReviewedAt: '2026-08-17T00:00:00.000Z',
        },
      }),
      saveState: async () => {},
    },
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.equal(reviewerCalls, 0);
  assert.equal(posterCalls, 0);
  assert.equal(diffCalls, 0);
});

test('Bitbucket expires an open unrequested posting plan into a fail-closed terminal head', async () => {
  const key = prKey('workspace/repo', 7, account);
  const loadedState = {};
  recordBitbucketPostingPlan(loadedState, key, {
    commitId: 'partial-head',
    body: 'Prepared summary',
    comments: [{
      path: 'src/a.js', line: 1, severity: 'major', comment: 'Partially posted finding',
    }],
    unrequestedAt: new Date(
      Date.now() - BITBUCKET_POSTING_PLAN_UNREQUESTED_TTL_MS - 1_000,
    ).toISOString(),
  });
  let savedState;
  let posterCalls = 0;
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer', model: null, reviewBatchSize: 1,
    reviewFocusCount: 1, reviewTimeoutMs: 60_000,
  };

  const result = await pollOnce({
    config, stateFile: '/unused/state.json', defaultReviewPromptPath: '/unused/template.md',
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies: {
      createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
      createGitHubMutationCadence: () => ({ run: (operation) => operation() }),
      resolveBitbucketAuth: async () => ({
        ...account, username: account.credentialUsername, password: 'secret',
      }),
      searchBitbucketReviewRequestedPRs: async () => [],
      getBitbucketPullRequest: async () => ({
        headRefOid: 'partial-head', number: 7, title: 'PR', body: '', state: 'OPEN',
        url: 'https://bitbucket.org/workspace/repo/pull-requests/7',
      }),
      postBitbucketReview: async () => { posterCalls += 1; },
      loadState: async () => loadedState,
      saveState: async (_path, state) => { savedState = structuredClone(state); },
    },
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.equal(posterCalls, 0);
  assert.equal(bitbucketPostingPlanFor(savedState, key, 'partial-head'), null);
  assert.equal(savedState[key].lastReviewedSha, undefined);
  assert.equal(savedState[key].bitbucketTerminalHeadSha, 'partial-head');
  assert.equal(
    bitbucketTerminalHeadFor(savedState, key, 'partial-head')?.disposition,
    'posting-plan-expired-unrequested',
  );
});

test('Bitbucket polling durably prunes terminal heads beyond retention without provider work', async () => {
  const key = prKey('workspace/repo', 7, account);
  let savedState;
  let saves = 0;
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer', model: null, reviewBatchSize: 1,
    reviewFocusCount: 1, reviewTimeoutMs: 60_000,
  };

  const result = await pollOnce({
    config, stateFile: '/unused/state.json', defaultReviewPromptPath: '/unused/template.md',
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies: {
      createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
      createGitHubMutationCadence: () => ({ run: (operation) => operation() }),
      resolveBitbucketAuth: async () => ({
        ...account, username: account.credentialUsername, password: 'secret',
      }),
      searchBitbucketReviewRequestedPRs: async () => [],
      getBitbucketPullRequest: async () => assert.fail('expired terminal must not fetch metadata'),
      loadState: async () => ({
        [key]: {
          bitbucketTerminalHeadSha: 'expired-head',
          terminalAt: '2000-01-01T00:00:00.000Z',
          disposition: 'posting-plan-expired-unrequested',
        },
      }),
      saveState: async (_path, state) => {
        saves += 1;
        savedState = structuredClone(state);
      },
    },
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.equal(saves, 1);
  assert.equal(savedState[key], undefined);
});

test('Bitbucket terminal heads do not consume cross-repository metadata quota', async () => {
  const terminalRepositories = Array.from(
    { length: MAX_CANDIDATE_METADATA_PER_POLL + 1 },
    (_, index) => `workspace/terminal-${index + 1}`,
  );
  const activeRepo = 'workspace/active';
  const scopedAccount = {
    ...account,
    repositories: [...terminalRepositories, activeRepo],
  };
  const loadedState = Object.fromEntries(
    terminalRepositories.map((repo, index) => [
      prKey(repo, index + 1, scopedAccount),
      {
        bitbucketTerminalHeadSha: `terminal-head-${index + 1}`,
        terminalAt: '2026-08-18T00:00:00.000Z',
        disposition: 'posting-plan-expired-unrequested',
      },
    ]),
  );
  const metadataCandidates = [];
  let reviewerCalls = 0;
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [scopedAccount],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [scopedAccount]),
    reviewerCommand: 'reviewer', model: null, reviewBatchSize: 1,
    reviewFocusCount: 1, reviewTimeoutMs: 60_000,
  };

  const result = await pollOnce({
    config, stateFile: '/unused/state.json', defaultReviewPromptPath: '/unused/template.md',
    dryRun: true,
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies: {
      createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
      createGitHubMutationCadence: () => ({ run: (operation) => operation() }),
      resolveBitbucketAuth: async () => ({
        ...scopedAccount,
        username: scopedAccount.credentialUsername,
        password: 'secret',
      }),
      searchBitbucketReviewRequestedPRs: async ({ repo }) =>
        repo === activeRepo ? [{ repo, number: 99 }] : [],
      getBitbucketPullRequest: async ({ repo, number }) => {
        metadataCandidates.push(`${repo}#${number}`);
        return {
          headRefOid: 'active-head', number, title: 'Active PR', body: '', state: 'OPEN',
          url: `https://bitbucket.org/${repo}/pull-requests/${number}`,
        };
      },
      getBitbucketPullRequestDiff: async () => '+++ b/a.js\n@@ -0,0 +1 @@\n+line\n',
      bitbucketReviewAlreadyPosted: async () => false,
      createBitbucketReviewMarker: () => '<!-- marker -->',
      ensureReviewPrompt: async () => '/virtual/prompt.md',
      readPrompt: async () => '{{diff}}',
      readLearnings: async () => '',
      invokeMultiPassReview: async () => {
        reviewerCalls += 1;
        return { summary: 'Summary', findings: [] };
      },
      prepareBitbucketReview: () => ({ anchorable: [], unanchorable: [] }),
      postBitbucketReview: async () => assert.fail('dry run must not post'),
      loadState: async () => loadedState,
      saveState: async () => assert.fail('dry run must not save state'),
    },
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.deepEqual(metadataCandidates, [`${activeRepo}#99`, `${activeRepo}#99`]);
  assert.equal(reviewerCalls, 1);
  assert.equal(result.outcomes[0].status, 'dry-run');
});

test('unrequested Bitbucket posting plans do not starve a later requested PR', async () => {
  const planOnlyRepositories = Array.from(
    { length: MAX_CANDIDATE_METADATA_PER_POLL + 1 },
    (_, index) => `workspace/plan-only-${index + 1}`,
  );
  const requestedRepo = 'workspace/requested';
  const scopedAccount = {
    ...account,
    repositories: [...planOnlyRepositories, requestedRepo],
  };
  const loadedState = {};
  for (const [index, repo] of planOnlyRepositories.entries()) {
    recordBitbucketPostingPlan(
      loadedState,
      prKey(repo, index + 1, scopedAccount),
      {
        commitId: `plan-head-${index + 1}`,
        body: 'Prepared summary',
        comments: [],
      },
    );
  }
  const metadataCandidates = [];
  let reviewerCalls = 0;
  let posterCalls = 0;
  let savedState;
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [scopedAccount],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [scopedAccount]),
    reviewerCommand: 'reviewer', model: null, reviewBatchSize: 1,
    reviewFocusCount: 1, reviewTimeoutMs: 60_000,
  };

  const result = await pollOnce({
    config, stateFile: '/unused/state.json', defaultReviewPromptPath: '/unused/template.md',
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies: {
      createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
      createGitHubMutationCadence: () => ({ run: (operation) => operation() }),
      resolveBitbucketAuth: async () => ({
        ...scopedAccount,
        username: scopedAccount.credentialUsername,
        password: 'secret',
      }),
      searchBitbucketReviewRequestedPRs: async ({ repo }) =>
        repo === requestedRepo ? [{ repo, number: 99 }] : [],
      getBitbucketPullRequest: async ({ repo, number }) => {
        metadataCandidates.push(`${repo}#${number}`);
        return {
          headRefOid: repo === requestedRepo ? 'requested-head' : `plan-head-${number}`,
          number,
          title: 'PR',
          body: '',
          state: 'OPEN',
          url: `https://bitbucket.org/${repo}/pull-requests/${number}`,
        };
      },
      getBitbucketPullRequestDiff: async () => '+++ b/a.js\n@@ -0,0 +1 @@\n+line\n',
      bitbucketReviewAlreadyPosted: async () => false,
      createBitbucketReviewMarker: () => '<!-- marker -->',
      ensureReviewPrompt: async () => '/virtual/prompt.md',
      readPrompt: async () => '{{diff}}',
      readLearnings: async () => '',
      invokeMultiPassReview: async () => {
        reviewerCalls += 1;
        return { summary: 'Summary', findings: [] };
      },
      postBitbucketReview: async () => { posterCalls += 1; },
      loadState: async () => loadedState,
      saveState: async (_path, state) => { savedState = structuredClone(state); },
    },
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.deepEqual(metadataCandidates, [
    `${requestedRepo}#99`,
    `${requestedRepo}#99`,
  ]);
  assert.equal(reviewerCalls, 1);
  assert.equal(posterCalls, 1);
  for (const [index, repo] of planOnlyRepositories.entries()) {
    assert.ok(
      bitbucketPostingPlanFor(
        savedState,
        prKey(repo, index + 1, scopedAccount),
        `plan-head-${index + 1}`,
      )?.unrequestedAt,
    );
  }
});

test('a renewed Bitbucket request remains blocked for its persisted terminal head', async () => {
  const key = prKey('workspace/repo', 7, account);
  let metadataReads = 0;
  let reviewerCalls = 0;
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer', model: null, reviewBatchSize: 1,
    reviewFocusCount: 1, reviewTimeoutMs: 60_000,
  };

  const result = await pollOnce({
    config, stateFile: '/unused/state.json', defaultReviewPromptPath: '/unused/template.md',
    dryRun: true,
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies: {
      createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
      createGitHubMutationCadence: () => ({ run: (operation) => operation() }),
      resolveBitbucketAuth: async () => ({
        ...account, username: account.credentialUsername, password: 'secret',
      }),
      searchBitbucketReviewRequestedPRs: async () => [{ repo: 'workspace/repo', number: 7 }],
      getBitbucketPullRequest: async () => {
        metadataReads += 1;
        return {
          headRefOid: 'terminal-head', number: 7, title: 'PR', body: '', state: 'OPEN',
          url: 'https://bitbucket.org/workspace/repo/pull-requests/7',
        };
      },
      getBitbucketPullRequestDiff: async () => assert.fail('terminal head must not fetch a diff'),
      invokeMultiPassReview: async () => { reviewerCalls += 1; return {}; },
      postBitbucketReview: async () => assert.fail('terminal head must not post'),
      loadState: async () => ({
        [key]: {
          bitbucketTerminalHeadSha: 'terminal-head',
          terminalAt: '2026-08-18T00:00:00.000Z',
          disposition: 'posting-plan-expired-unrequested',
        },
      }),
      saveState: async () => assert.fail('dry run must not save state'),
    },
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.equal(metadataReads, 1);
  assert.equal(reviewerCalls, 0);
});

test('Bitbucket plan-only records enter state-only expiry without metadata polling', async () => {
  const key = prKey('workspace/repo', 7, account);
  const loadedState = {};
  recordBitbucketPostingPlan(loadedState, key, {
    commitId: 'closed-head',
    body: 'Prepared summary',
    comments: [],
  });
  let saves = 0;
  let savedState;
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer', model: null, reviewBatchSize: 1,
    reviewFocusCount: 1, reviewTimeoutMs: 60_000,
  };

  const result = await pollOnce({
    config, stateFile: '/unused/state.json', defaultReviewPromptPath: '/unused/template.md',
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies: {
      createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
      createGitHubMutationCadence: () => ({ run: (operation) => operation() }),
      resolveBitbucketAuth: async () => ({
        ...account, username: account.credentialUsername, password: 'secret',
      }),
      searchBitbucketReviewRequestedPRs: async () => [],
      getBitbucketPullRequest: async () => assert.fail(
        'unrequested plan-only records must not fetch PR metadata',
      ),
      loadState: async () => loadedState,
      saveState: async (_path, state) => {
        saves += 1;
        savedState = structuredClone(state);
      },
    },
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.equal(saves, 1);
  assert.ok(
    bitbucketPostingPlanFor(savedState, key, 'closed-head')?.unrequestedAt,
  );
  assert.equal(savedState[key], undefined);
});

test('Bitbucket closed-state cleanup restores the review and plan when its atomic save fails', async () => {
  const key = prKey('workspace/repo', 7, account);
  const loadedState = {
    [key]: {
      lastReviewedSha: 'older-head',
      lastReviewedAt: '2026-08-17T00:00:00.000Z',
    },
  };
  recordBitbucketPostingPlan(loadedState, key, {
    commitId: 'closed-head',
    body: 'Prepared summary',
    comments: [],
  });
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer', model: null, reviewBatchSize: 1,
    reviewFocusCount: 1, reviewTimeoutMs: 60_000,
  };

  const result = await pollOnce({
    config, stateFile: '/unused/state.json', defaultReviewPromptPath: '/unused/template.md',
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies: {
      createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
      createGitHubMutationCadence: () => ({ run: (operation) => operation() }),
      resolveBitbucketAuth: async () => ({
        ...account, username: account.credentialUsername, password: 'secret',
      }),
      searchBitbucketReviewRequestedPRs: async () => [],
      getBitbucketPullRequest: async () => ({
        headRefOid: 'closed-head', number: 7, title: 'PR', body: '', state: 'CLOSED',
        url: 'https://bitbucket.org/workspace/repo/pull-requests/7',
      }),
      loadState: async () => loadedState,
      saveState: async (_path, state) => {
        if (state[key] !== undefined) {
          assert.ok(bitbucketPostingPlanFor(state, key, 'closed-head')?.unrequestedAt);
          return;
        }
        assert.equal(bitbucketPostingPlanFor(state, key, 'closed-head'), null);
        throw new Error('disk full');
      },
    },
  });

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'tracking cleanup failed');
  assert.equal(loadedState[key].lastReviewedSha, 'older-head');
  assert.equal(
    bitbucketPostingPlanFor(loadedState, key, 'closed-head')?.body,
    'Prepared summary',
  );
});

test('Bitbucket retry reuses the durable posting plan across reordered and reworded reviewer output', async () => {
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer', model: null, reviewBatchSize: 1,
    reviewFocusCount: 1, reviewTimeoutMs: 60_000,
  };
  let durableState = {};
  let reviewerCalls = 0;
  let failSecondFinding = true;
  const storedComments = [];
  const diff = '+++ b/src/a.js\n@@ -0,0 +1 @@\n+line\n';
  const first = {
    path: 'src/a.js', line: 1, severity: 'major', comment: 'First original finding',
  };
  const second = {
    path: 'src/a.js', line: 1, severity: 'major', comment: 'Second original finding',
  };
  const fakeApi = async (request) => {
    if (request.method !== 'POST') return { values: storedComments };
    const raw = request.body.content.raw;
    if (request.body.inline && raw.includes(second.comment) && failSecondFinding) {
      failSecondFinding = false;
      throw new Error('temporary transport failure');
    }
    storedComments.push({
      user: { uuid: account.accountId },
      content: { raw },
      inline: request.body.inline,
    });
    return { id: storedComments.length };
  };
  const dependencies = {
    createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
    createGitHubMutationCadence: () => ({
      run: async (operation, { beforeStart } = {}) => {
        await beforeStart?.();
        return operation();
      },
    }),
    resolveBitbucketAuth: async () => ({
      ...account,
      username: account.credentialUsername,
      password: 'secret',
    }),
    searchBitbucketReviewRequestedPRs: async () => [{ repo: 'workspace/repo', number: 7 }],
    getBitbucketPullRequest: async () => ({
      headRefOid: 'stable-head', number: 7, title: 'PR', body: '', state: 'OPEN',
      url: 'https://bitbucket.org/workspace/repo/pull-requests/7',
    }),
    getBitbucketPullRequestDiff: async () => diff,
    bitbucketReviewAlreadyPosted: (args) => bitbucketReviewAlreadyPosted({
      ...args,
      api: fakeApi,
    }),
    ensureReviewPrompt: async () => '/virtual/prompt.md',
    readPrompt: async () => '{{diff}}',
    readLearnings: async () => '',
    invokeMultiPassReview: async () => {
      reviewerCalls += 1;
      return reviewerCalls === 1
        ? { summary: 'Original summary', findings: [first, second] }
        : {
          summary: 'Reworded summary',
          findings: [
            { ...second, comment: 'Second reworded finding' },
            { ...first, comment: 'First reworded finding' },
          ],
        };
    },
    postBitbucketReview: (args) => postBitbucketReview({ ...args, api: fakeApi }),
    loadState: async () => structuredClone(durableState),
    saveState: async (_path, state) => { durableState = structuredClone(state); },
  };
  const pollOptions = {
    config,
    stateFile: '/unused/state.json',
    defaultReviewPromptPath: '/unused/template.md',
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies,
  };

  const firstPoll = await pollOnce(pollOptions);
  assert.equal(firstPoll.failed, true);
  assert.equal(reviewerCalls, 1);
  assert.ok(durableState[STATE_METADATA_KEY]?.bitbucketPostingPlans);

  const secondPoll = await pollOnce(pollOptions);
  assert.equal(secondPoll.failed, false);
  assert.equal(secondPoll.reviewed, 1);
  assert.equal(reviewerCalls, 1);
  const inline = storedComments.filter((comment) => comment.inline);
  assert.equal(inline.filter((comment) => comment.content.raw.includes(first.comment)).length, 1);
  assert.equal(inline.filter((comment) => comment.content.raw.includes(second.comment)).length, 1);
  assert.equal(inline.some((comment) => /reworded/u.test(comment.content.raw)), false);
  assert.equal(durableState[STATE_METADATA_KEY]?.bitbucketPostingPlans, undefined);
});

test('Bitbucket rejects an unrenderable posting plan before persistence and retries review', async () => {
  const config = {
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer', model: null, reviewBatchSize: 1,
    reviewFocusCount: 1, reviewTimeoutMs: 60_000,
  };
  let durableState = {};
  let reviewerCalls = 0;
  let providerCalls = 0;
  let planWrites = 0;
  const diff = '+++ b/src/a.js\n@@ -0,0 +1 @@\n+line\n';
  const oversizedWhenDemoted = Array.from({ length: 7 }, (_, index) => ({
    path: 'src/a.js',
    line: 1,
    severity: 'major',
    comment: `${index}: ${'x'.repeat(3_987)}`,
  }));
  const dependencies = {
    createGitHubMutationQueue: () => ({ run: (operation) => operation() }),
    createGitHubMutationCadence: () => ({
      run: async (operation, { beforeStart } = {}) => {
        await beforeStart?.();
        return operation();
      },
    }),
    resolveBitbucketAuth: async () => ({
      ...account,
      username: account.credentialUsername,
      password: 'secret',
    }),
    searchBitbucketReviewRequestedPRs: async () => [{ repo: 'workspace/repo', number: 7 }],
    getBitbucketPullRequest: async () => ({
      headRefOid: 'oversized-head', number: 7, title: 'PR', body: '', state: 'OPEN',
      url: 'https://bitbucket.org/workspace/repo/pull-requests/7',
    }),
    getBitbucketPullRequestDiff: async () => diff,
    bitbucketReviewAlreadyPosted: async () => false,
    ensureReviewPrompt: async () => '/virtual/prompt.md',
    readPrompt: async () => '{{diff}}',
    readLearnings: async () => '',
    invokeMultiPassReview: async () => {
      reviewerCalls += 1;
      return { summary: 'Summary', findings: oversizedWhenDemoted };
    },
    postBitbucketReview: async () => {
      providerCalls += 1;
      throw new Error('an unrenderable plan must not reach the provider');
    },
    loadState: async () => structuredClone(durableState),
    saveState: async (_path, state) => {
      if (state[STATE_METADATA_KEY]?.bitbucketPostingPlans) planWrites += 1;
      durableState = structuredClone(state);
    },
  };
  const pollOptions = {
    config,
    stateFile: '/unused/state.json',
    defaultReviewPromptPath: '/unused/template.md',
    logger: {
      child: () => ({ info() {}, warn() {}, error() {}, output() {} }),
      info() {}, warn() {}, error() {}, output() {}, flush: async () => {},
    },
    dependencies,
  };

  const firstPoll = await pollOnce(pollOptions);
  const secondPoll = await pollOnce(pollOptions);

  assert.equal(firstPoll.failed, true);
  assert.equal(firstPoll.failures[0].note, 'posting plan persistence failed');
  assert.equal(secondPoll.failed, true);
  assert.equal(secondPoll.failures[0].note, 'posting plan persistence failed');
  assert.equal(reviewerCalls, 2);
  assert.equal(providerCalls, 0);
  assert.equal(planWrites, 0);
  assert.equal(durableState[STATE_METADATA_KEY]?.bitbucketPostingPlans, undefined);
});

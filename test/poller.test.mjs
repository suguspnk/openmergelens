import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pollOnce } from '../lib/poller.mjs';
import { postReview as productionPostReview } from '../lib/github.mjs';
import {
  createGitHubMutationCadence,
  createGitHubMutationQueue,
} from '../lib/github-mutation-queue.mjs';
import {
  MAX_CONCURRENT_REVIEW_ADMISSIONS,
  MAX_REVIEWS_PER_POLL,
} from '../lib/security-limits.mjs';
import { MAX_CANDIDATE_METADATA_PER_POLL } from '../lib/poller.mjs';
import { prKey, saveState } from '../lib/state.mjs';
import { createAiProcessingConsent } from '../lib/ai-processing-consent.mjs';

const work = {
  hostname: 'github.com',
  username: 'work',
  repositories: ['owner/repo'],
};
const personal = {
  hostname: 'github.com',
  username: 'personal',
  repositories: ['owner/repo'],
};

function config(accounts = [work, personal]) {
  return {
    configVersion: 5,
    githubAccounts: accounts,
    aiProcessingConsent: createAiProcessingConsent('reviewer', accounts),
    reviewerCommand: 'reviewer',
    model: null,
    reviewerInputMode: 'stdin',
    reviewBatchSize: 2,
    reviewFocusCount: 1,
    stateFile: './state.json',
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-poller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    stateFile: path.join(root, 'state.json'),
    logPath: path.join(root, 'poll.log'),
    defaultReviewPromptPath: path.join(root, 'template.md'),
  };
}

function successfulDependencies(events) {
  return {
    createGitHubMutationQueue: () => ({
      run: async (operation) => {
        events.push('github:scheduled');
        return operation();
      },
    }),
    createGitHubMutationCadence: () => ({
      run: async (operation, { beforeStart } = {}) => {
        if (beforeStart) await beforeStart();
        return operation();
      },
    }),
    resolveGitHubAuth: async (account) => ({ ...account, token: `${account.username}-token` }),
    currentUsername: async ({ auth }) => auth.username,
    searchReviewRequestedPRs: async ({ username, repo }) => {
      events.push(`search:${username}:${repo}`);
      return [{ repo, number: 7 }];
    },
    getPullRequest: async () => ({
      headRefOid: 'sha-1',
      number: 7,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: 'OPEN',
    }),
    getPullRequestDiff: async () => '@@ -0,0 +1 @@\n+line\n',
    reviewAlreadyPosted: async () => false,
    ensureReviewPrompt: async () => '/virtual/prompt.md',
    readPrompt: async () => '{{diff}}',
    readLearnings: async (account) => `learning:${account.username}`,
    invokeMultiPassReview: async ({ learnings }) => {
      events.push(`review:${learnings}`);
      return { summary: 'reviewed', findings: [] };
    },
    postReview: async ({ auth, scheduleMutation }) =>
      scheduleMutation(async () => {
        events.push(`post:${auth.username}`);
      }),
  };
}

function admissionStressDependencies(failureStage, stats) {
  const candidateCount = 8;
  const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
  const fail = (stage, number) => {
    if (failureStage === stage && number === 1) {
      throw new Error(`${stage} failed`);
    }
  };

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
    resolveGitHubAuth: async (account) => ({ ...account, token: 'token' }),
    currentUsername: async ({ auth }) => auth.username,
    searchReviewRequestedPRs: async ({ repo }) =>
      Array.from({ length: candidateCount }, (_, index) => ({
        repo,
        number: index + 1,
      })),
    getPullRequest: async ({ repo, number }) => ({
      headRefOid: `sha-${number}`,
      number,
      title: `PR ${number}`,
      url: `https://github.com/owner/repo/pull/${number}`,
      body: '',
      state: 'OPEN',
      repo,
    }),
    getPullRequestDiff: async ({ number }) => {
      stats.activeDiffs += 1;
      stats.maxActiveDiffs = Math.max(stats.maxActiveDiffs, stats.activeDiffs);
      await delay();
      stats.activeDiffs -= 1;
      stats.diffStarts += 1;
      fail('diff', number);
      return `@@ -0,0 +1 @@\n+${'x'.repeat(1024 * 1024)}\n`;
    },
    reviewAlreadyPosted: async () => false,
    ensureReviewPrompt: async () => '/virtual/prompt.md',
    readPrompt: async () => '{{diff}}',
    readLearnings: async () => '',
    invokeMultiPassReview: async ({ pr }) => {
      stats.activeReviewers += 1;
      stats.maxActiveReviewers = Math.max(
        stats.maxActiveReviewers,
        stats.activeReviewers,
      );
      await delay();
      stats.activeReviewers -= 1;
      stats.reviewerStarts += 1;
      fail('reviewer', pr.number);
      return { summary: 'reviewed', findings: [] };
    },
    postReview: async ({ number, scheduleMutation }) => scheduleMutation(async () => {
      stats.activePosts += 1;
      stats.maxActivePosts = Math.max(stats.maxActivePosts, stats.activePosts);
      await delay();
      stats.activePosts -= 1;
      stats.postStarts += 1;
      fail('post', number);
    }),
    loadState: async () => ({}),
    saveState: async () => {},
  };
}

test('two requested accounts independently review and persist the same PR', async (t) => {
  const files = await fixture(t);
  const events = [];
  const result = await pollOnce({
    config: config(),
    ...files,
    dependencies: successfulDependencies(events),
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 2);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(
    result.outcomes.map(({ status, repo, number }) => ({ status, repo, number })),
    [
      { status: 'reviewed', repo: 'owner/repo', number: 7 },
      { status: 'reviewed', repo: 'owner/repo', number: 7 },
    ],
  );
  assert.deepEqual(events.filter((event) => event.startsWith('post:')).sort(), [
    'post:personal',
    'post:work',
  ]);
  assert.equal(
    events.filter((event) => event === 'github:scheduled').length,
    14,
  );
  assert.deepEqual(events.filter((event) => event.startsWith('review:')).sort(), [
    'review:learning:personal',
    'review:learning:work',
  ]);

  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.deepEqual(Object.keys(state).sort(), [
    'github.com@personal::owner/repo#7',
    'github.com@work::owner/repo#7',
  ]);
});

for (const [label, malformedMetadata] of [
  ['null', null],
  ['missing state', {
    headRefOid: 'sha-1',
    number: 1,
    title: 'PR 1',
    url: 'https://github.com/owner/repo/pull/1',
    body: '',
  }],
  ['missing headRefOid', {
    number: 1,
    title: 'PR 1',
    url: 'https://github.com/owner/repo/pull/1',
    body: '',
    state: 'OPEN',
  }],
  ['blank headRefOid', {
    headRefOid: '   ',
    number: 1,
    title: 'PR 1',
    url: 'https://github.com/owner/repo/pull/1',
    body: '',
    state: 'OPEN',
  }],
]) {
  test(`malformed ${label} metadata fails one candidate and continues`, async (t) => {
    const files = await fixture(t);
    const account = { ...work, repositories: ['owner/repo'] };
    const initialEntry = {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    };
    await saveState(files.stateFile, {
      [prKey('owner/repo', 1, account)]: initialEntry,
    });

    const events = [];
    const dependencies = successfulDependencies(events);
    dependencies.searchReviewRequestedPRs = async () => [
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
    ];
    dependencies.getPullRequest = async ({ number }) => {
      if (number === 1) return malformedMetadata;
      return {
        headRefOid: 'sha-2',
        number: 2,
        title: 'PR 2',
        url: 'https://github.com/owner/repo/pull/2',
        body: '',
        state: 'OPEN',
      };
    };

    const result = await pollOnce({
      config: config([account]),
      ...files,
      dependencies,
    });

    assert.equal(result.failed, true);
    assert.equal(result.reviewed, 1);
    assert.deepEqual(
      result.failures.map(({ repo, number, note }) => ({ repo, number, note })),
      [{ repo: 'owner/repo', number: 1, note: 'metadata malformed' }],
    );
    assert.deepEqual(
      result.outcomes.map(({ status, number }) => ({ status, number })),
      [{ status: 'reviewed', number: 2 }],
    );
    assert.deepEqual(
      events.filter((event) => event.startsWith('post:')),
      ['post:work'],
    );

    const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
    assert.deepEqual(state[prKey('owner/repo', 1, account)], initialEntry);
    assert.equal(state[prKey('owner/repo', 2, account)].lastReviewedSha, 'sha-2');
  });
}

test('pollOnce adopts a current unscoped entry for its only selected account', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const initialEntry = {
    lastReviewedSha: 'sha-1',
    lastReviewedAt: '2026-08-05T00:00:00.000Z',
  };
  await writeFile(files.stateFile, JSON.stringify({ 'OWNER/REPO#7': initialEntry }));

  const events = [];
  const dependencies = successfulDependencies(events);
  let reconciliationCalls = 0;
  dependencies.reviewAlreadyPosted = async () => {
    reconciliationCalls += 1;
    return false;
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.outcomes, []);
  assert.equal(reconciliationCalls, 0);
  assert.deepEqual(events.filter((event) => event.startsWith('review:')), []);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), {
    [prKey('owner/repo', 7, account)]: initialEntry,
  });
});

test('pollOnce rolls back legacy adoption when migration persistence fails', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const initialState = {
    'owner/repo#7': {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  };
  await writeFile(files.stateFile, JSON.stringify(initialState));

  const events = [];
  const dependencies = successfulDependencies(events);
  dependencies.saveState = async () => {
    throw new Error('disk full');
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.outcomes, []);
  assert.deepEqual(
    result.failures.map(({ note }) => note),
    ['legacy state migration failed'],
  );
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
});

test('pollOnce retains ambiguous unscoped state across multiple selected accounts', async (t) => {
  const files = await fixture(t);
  const initialEntry = {
    lastReviewedSha: 'sha-1',
    lastReviewedAt: '2026-08-05T00:00:00.000Z',
  };
  await writeFile(files.stateFile, JSON.stringify({ 'owner/repo#7': initialEntry }));

  const events = [];
  const result = await pollOnce({
    config: config([work, personal]),
    ...files,
    dependencies: successfulDependencies(events),
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 2);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')).sort(), [
    'post:personal',
    'post:work',
  ]);
  const persisted = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.deepEqual(persisted['owner/repo#7'], initialEntry);
  assert.equal(persisted[prKey('owner/repo', 7, work)].lastReviewedSha, 'sha-1');
  assert.equal(persisted[prKey('owner/repo', 7, personal)].lastReviewedSha, 'sha-1');
});

test('pollOnce does not adopt legacy state when --account selects one of multiple configured accounts', async (t) => {
  const files = await fixture(t);
  const initialEntry = {
    lastReviewedSha: 'sha-1',
    lastReviewedAt: '2026-08-05T00:00:00.000Z',
  };
  await writeFile(files.stateFile, JSON.stringify({ 'owner/repo#7': initialEntry }));

  const events = [];
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  const result = await pollOnce({
    config: config(),
    ...files,
    accountSelector: { hostname: 'github.com', username: 'work' },
    dependencies: successfulDependencies(events),
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(result.outcomes[0].status, 'reviewed');
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), ['post:work']);
  assert.match(
    output.join('\n'),
    /legacy unscoped review state retained: multiple configured accounts make the previous reviewer ambiguous/,
  );

  const persisted = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.deepEqual(persisted['owner/repo#7'], initialEntry);
  assert.equal(persisted[prKey('owner/repo', 7, work)].lastReviewedSha, 'sha-1');
});

test('account-filtered dry runs retain legacy state without writing it', async (t) => {
  const files = await fixture(t);
  const initialState = {
    'owner/repo#7': {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  };
  await writeFile(files.stateFile, JSON.stringify(initialState));

  const events = [];
  let saveCalls = 0;
  const dependencies = successfulDependencies(events);
  dependencies.saveState = async () => {
    saveCalls += 1;
  };
  const result = await pollOnce({
    config: config(),
    ...files,
    dryRun: true,
    accountSelector: { hostname: 'github.com', username: 'work' },
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(result.outcomes[0].status, 'dry-run');
  assert.equal(saveCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
});

test('initial reconciliation rate limits back off the next PR before it can post', async (t) => {
  const files = await fixture(t);
  const events = [];
  let clock = 20_000;
  const sleeps = [];
  const account = { ...work, repositories: ['owner/repo'] };
  const queue = createGitHubMutationQueue({
    minIntervalMs: 1_000,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });
  const dependencies = successfulDependencies(events);
  dependencies.createGitHubMutationQueue = () => queue;
  dependencies.searchReviewRequestedPRs = async () => [
    { repo: 'owner/repo', number: 1 },
    { repo: 'owner/repo', number: 2 },
  ];
  dependencies.getPullRequest = async ({ number }) => ({
    headRefOid: `sha-${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/owner/repo/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  dependencies.reviewAlreadyPosted = async ({ number }) => {
    events.push(`reconcile:${number}@${clock}`);
    if (number === 1) {
      throw Object.assign(new Error('HTTP 429: Too Many Requests'), {
        status: 429,
        retryAfterMs: 5_000,
      });
    }
    return false;
  };
  dependencies.getPullRequestDiff = async ({ number }) => {
    events.push(`diff:${number}@${clock}`);
    return '@@ -0,0 +1 @@\n+line\n';
  };
  dependencies.invokeMultiPassReview = async ({ pr }) => {
    events.push(`review:${pr.number}@${clock}`);
    return { summary: 'reviewed', findings: [] };
  };
  dependencies.postReview = async ({ number, scheduleMutation }) =>
    scheduleMutation(async () => {
      events.push(`post:${number}@${clock}`);
    });

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].number, 1);
  assert.equal(result.failures[0].note, 'review reconciliation failed');
  assert.deepEqual(result.outcomes.map(({ number, status }) => ({ number, status })), [
    { number: 2, status: 'reviewed' },
  ]);
  assert.deepEqual(sleeps, [
    1_000,
    1_000,
    1_000,
    1_000,
    5_000,
    1_000,
    1_000,
    1_000,
  ]);
  assert.deepEqual(events, [
    'reconcile:1@24000',
    'reconcile:2@29000',
    'diff:2@30000',
    'review:2@30000',
    'post:2@32000',
  ]);
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(files.stateFile, 'utf8'))),
    ['github.com@work::owner/repo#2'],
  );
});

test('rate-limited ordinary reads delay the next candidate ordinary read', async (t) => {
  const files = await fixture(t);
  let clock = 20_000;
  const sleeps = [];
  const metadataStarts = [];
  const account = { ...work, repositories: ['owner/repo'] };
  const queue = createGitHubMutationQueue({
    minIntervalMs: 0,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });
  const dependencies = successfulDependencies([]);
  dependencies.createGitHubMutationQueue = () => queue;
  dependencies.searchReviewRequestedPRs = async () => [
    { repo: 'owner/repo', number: 1 },
    { repo: 'owner/repo', number: 2 },
  ];
  dependencies.getPullRequest = async ({ number }) => {
    if (number === 1) {
      throw Object.assign(new Error('HTTP 429: Too Many Requests'), {
        status: 429,
        retryAfterMs: 5_000,
      });
    }
    metadataStarts.push(clock);
    return {
      headRefOid: 'sha-2',
      number,
      title: 'PR 2',
      url: 'https://github.com/owner/repo/pull/2',
      body: '',
      state: 'CLOSED',
    };
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].number, 1);
  assert.deepEqual(sleeps, [5_000]);
  assert.deepEqual(metadataStarts, [25_000]);
});

test('account schedulers isolate rate-limit backoff by account and host', async (t) => {
  const files = await fixture(t);
  let clock = 0;
  const sleeps = [];
  const events = [];
  const githubAccounts = [
    { hostname: 'github.com', username: 'account-a', repositories: ['owner/repo'] },
    { hostname: 'github.com', username: 'account-b', repositories: ['owner/repo'] },
    { hostname: 'enterprise.example.com', username: 'account-a', repositories: ['owner/repo'] },
  ];
  const trackedKey = prKey('owner/repo', 7, githubAccounts[0]);
  const dependencies = successfulDependencies(events);
  let queueIndex = 0;
  dependencies.createGitHubMutationQueue = () => {
    const queueLabel = githubAccounts[queueIndex++];
    return createGitHubMutationQueue({
      minIntervalMs: 0,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push({ account: queueLabel.username, host: queueLabel.hostname, milliseconds });
        clock += milliseconds;
      },
    });
  };
  dependencies.loadState = async () => ({
    [trackedKey]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });
  dependencies.currentUsername = async ({ auth }) => {
    events.push(`current:${auth.username}@${auth.hostname}:${clock}`);
    return auth.username;
  };
  dependencies.searchReviewRequestedPRs = async ({ username, repo, auth }) => {
    events.push(`search:${username}:${repo}@${clock}`);
    if (
      username === 'account-a' &&
      auth.hostname === 'github.com' &&
      repo === 'owner/repo'
    ) {
      throw Object.assign(new Error('HTTP 429: Too Many Requests'), {
        status: 429,
        retryAfterMs: 5_000,
      });
    }
    return [];
  };
  dependencies.getPullRequest = async ({ auth, number }) => {
    events.push(`metadata:${auth.username}@${auth.hostname}#${number}:${clock}`);
    return {
      headRefOid: 'sha-1',
      number,
      title: 'PR',
      url: `https://${auth.hostname}/owner/repo/pull/${number}`,
      body: '',
      state: 'CLOSED',
    };
  };

  const result = await pollOnce({
    config: config(githubAccounts),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.equal(result.failures[0].note, 'search failed');
  assert.deepEqual(events, [
    'current:account-a@github.com:0',
    'current:account-b@github.com:0',
    'current:account-a@enterprise.example.com:0',
    'search:account-a:owner/repo@0',
    'search:account-b:owner/repo@0',
    'search:account-a:owner/repo@0',
    'metadata:account-a@github.com#7:5000',
  ]);
  assert.deepEqual(sleeps, [
    { account: 'account-a', host: 'github.com', milliseconds: 5_000 },
  ]);
  assert.equal(queueIndex, 3);
});

test('healthy account discovery starts before another account read backoff expires', async (t) => {
  const files = await fixture(t);
  let clock = 0;
  const sleeps = [];
  const events = [];
  const githubAccounts = [
    {
      hostname: 'github.com',
      username: 'account-a',
      repositories: ['owner/one', 'owner/two'],
    },
    {
      hostname: 'github.com',
      username: 'account-b',
      repositories: ['owner/three'],
    },
  ];
  const dependencies = successfulDependencies(events);
  let queueIndex = 0;
  dependencies.createGitHubMutationQueue = () => {
    const queueAccount = githubAccounts[queueIndex++];
    return createGitHubMutationQueue({
      minIntervalMs: 0,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push({ account: queueAccount.username, milliseconds });
        clock += milliseconds;
      },
    });
  };
  dependencies.currentUsername = async ({ auth }) => {
    events.push(`current:${auth.username}@${clock}`);
    return auth.username;
  };
  dependencies.searchReviewRequestedPRs = async ({ username, repo }) => {
    events.push(`search:${username}:${repo}@${clock}`);
    if (username === 'account-a' && repo === 'owner/one') {
      throw Object.assign(new Error('HTTP 429: Too Many Requests'), {
        status: 429,
        retryAfterMs: 5_000,
      });
    }
    return [];
  };

  const result = await pollOnce({
    config: config(githubAccounts),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(sleeps, [
    { account: 'account-a', milliseconds: 5_000 },
  ]);
  assert.ok(
    Number(events.find((event) => event.startsWith('current:account-b@')).split('@')[1]) < 5_000,
  );
  assert.ok(
    Number(events.find((event) => event.startsWith('search:account-b:')).split('@')[1]) < 5_000,
  );
});

test('account six starts before a slow two-repository account backoff expires', async (t) => {
  const files = await fixture(t);
  const events = [];
  const githubAccounts = [
    {
      hostname: 'github.com',
      username: 'account-1',
      repositories: ['owner/slow-one', 'owner/slow-two'],
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      hostname: 'github.com',
      username: `account-${index + 2}`,
      repositories: [`owner/fast-${index + 2}`],
    })),
    {
      hostname: 'github.com',
      username: 'account-6',
      repositories: ['owner/fast-six'],
    },
  ];
  const dependencies = successfulDependencies(events);
  let queueIndex = 0;
  let slowBackoffStarted = false;
  let slowBackoffResolved = false;
  let accountSixStartedBeforeBackoffResolved = false;
  let releaseSlowBackoffStarted;
  const slowBackoffStartedSignal = new Promise((resolve) => {
    releaseSlowBackoffStarted = resolve;
  });
  let releaseFastSearches;
  const fastSearches = new Promise((resolve) => {
    releaseFastSearches = resolve;
  });
  let releaseSlowBackoff;
  const slowBackoff = new Promise((resolve) => {
    releaseSlowBackoff = resolve;
  });

  dependencies.createGitHubMutationQueue = () => {
    const queueAccount = githubAccounts[queueIndex++];
    return createGitHubMutationQueue({
      minIntervalMs: 0,
      sleep: async (milliseconds) => {
        if (queueAccount.username !== 'account-1') return;
        slowBackoffStarted = true;
        releaseSlowBackoffStarted();
        releaseFastSearches();
        await slowBackoff;
        slowBackoffResolved = true;
      },
    });
  };
  dependencies.currentUsername = async ({ auth }) => {
    events.push(`current:${auth.username}`);
    if (auth.username === 'account-6') {
      // Wait until account 1 has actually entered its backoff. This preserves
      // the fairness assertion without depending on platform timer ordering.
      await slowBackoffStartedSignal;
      accountSixStartedBeforeBackoffResolved =
        slowBackoffStarted && !slowBackoffResolved;
      releaseSlowBackoff();
    }
    return auth.username;
  };
  dependencies.searchReviewRequestedPRs = async ({ username, repo }) => {
    events.push(`search:${username}:${repo}`);
    if (username === 'account-1' && repo === 'owner/slow-one') {
      throw Object.assign(new Error('HTTP 429: Too Many Requests'), {
        status: 429,
        retryAfterMs: 5_000,
      });
    }
    if (username !== 'account-1') await fastSearches;
    return [];
  };

  const result = await pollOnce({
    config: config(githubAccounts),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.ok(events.includes('current:account-6'));
  assert.equal(accountSixStartedBeforeBackoffResolved, true);
  assert.equal(slowBackoffResolved, true);
});

test('review POST attempts stay globally spaced across accounts, including 422 fallback', async (t) => {
  const files = await fixture(t);
  let clock = 0;
  const postStarts = [];
  const postAttemptsByAccount = new Map();
  const dependencies = successfulDependencies([]);
  dependencies.createGitHubMutationQueue = () => createGitHubMutationQueue({
    minIntervalMs: 0,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  });
  dependencies.createGitHubMutationCadence = () => createGitHubMutationCadence({
    minIntervalMs: 1_000,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  });
  const metadataCallsByAccount = new Map();
  dependencies.getPullRequest = async ({ auth, number, repo }) => {
    const calls = (metadataCallsByAccount.get(auth.username) ?? 0) + 1;
    metadataCallsByAccount.set(auth.username, calls);
    if (auth.username === 'work' && (calls === 3 || calls === 4)) {
      clock += 900;
    }
    return {
      headRefOid: 'sha-1',
      number,
      title: 'PR',
      url: `https://${auth.hostname}/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };
  dependencies.getPullRequestDiff = async () =>
    '+++ b/file.js\n@@ -0,0 +1 @@\n+line\n';
  dependencies.invokeMultiPassReview = async () => ({
    summary: 'reviewed',
    findings: [{
      path: 'file.js',
      line: 1,
      severity: 'major',
      comment: 'fix this',
    }],
  });
  dependencies.postReview = async (options) => productionPostReview({
    ...options,
    request: async (args) => {
      const method = args[args.indexOf('--method') + 1];
      if (method === 'GET') return '';
      const accountAttempts = (postAttemptsByAccount.get(options.auth.username) ?? 0) + 1;
      postAttemptsByAccount.set(options.auth.username, accountAttempts);
      postStarts.push({ account: options.auth.username, startedAt: clock });
      if (accountAttempts === 1) {
        throw Object.assign(new Error('HTTP 422: Validation Failed'), { status: 422 });
      }
      return '{}';
    },
  });

  const result = await pollOnce({
    config: config([work, personal]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 2);
  assert.equal(postStarts.length, 4);
  assert.ok(postStarts.every(({ startedAt }, index) =>
    index === 0 || startedAt - postStarts[index - 1].startedAt >= 1_000,
  ));
  assert.deepEqual(
    [...postAttemptsByAccount.entries()].sort(),
    [['personal', 2], ['work', 2]],
  );
});

test('a rate-limited account does not impose its backoff on another account review POST', async (t) => {
  const files = await fixture(t);
  let clock = 0;
  const postStarts = [];
  const dependencies = successfulDependencies([]);
  dependencies.createGitHubMutationQueue = () => createGitHubMutationQueue({
    minIntervalMs: 0,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  });
  dependencies.createGitHubMutationCadence = () => createGitHubMutationCadence({
    minIntervalMs: 1_000,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  });
  dependencies.postReview = async ({ auth, scheduleMutation }) => {
    if (auth.username === 'personal') {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return scheduleMutation(async () => {
      postStarts.push({ account: auth.username, startedAt: clock });
      if (auth.username === 'work') {
        throw Object.assign(new Error('HTTP 429: Too Many Requests'), {
          status: 429,
          retryAfterMs: 5_000,
        });
      }
    });
  };

  const result = await pollOnce({
    config: config([work, personal]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 1);
  assert.deepEqual(postStarts, [
    { account: 'work', startedAt: 0 },
    { account: 'personal', startedAt: 1_000 },
  ]);
});

test('a tracked PR with a changed head is re-reviewed when discovery returns no requests', async (t) => {
  const files = await fixture(t);
  const events = [];
  const account = { ...work, repositories: ['owner/repo'] };
  await saveState(files.stateFile, {
    [prKey('owner/repo', 7, account)]: {
      lastReviewedSha: 'sha-A',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });

  const dependencies = successfulDependencies(events);
  dependencies.searchReviewRequestedPRs = async () => [];
  dependencies.getPullRequest = async () => ({
    headRefOid: 'sha-B',
    number: 7,
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    body: '',
    state: 'OPEN',
  });
  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(result.outcomes[0].status, 're-reviewed');
  assert.deepEqual(events.filter((event) => event.startsWith('review:')), [
    'review:learning:work',
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), ['post:work']);
  assert.equal(
    JSON.parse(await readFile(files.stateFile, 'utf8'))[
      prKey('owner/repo', 7, account)
    ].lastReviewedSha,
    'sha-B',
  );
});

test('a tracked PR is reconciled and re-reviewed when discovery fails', async (t) => {
  const files = await fixture(t);
  const events = [];
  const account = { ...work, repositories: ['owner/repo'] };
  await saveState(files.stateFile, {
    [prKey('owner/repo', 7, account)]: {
      lastReviewedSha: 'sha-A',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });

  const dependencies = successfulDependencies(events);
  dependencies.searchReviewRequestedPRs = async () => {
    throw Object.assign(new Error('HTTP 503: Service Unavailable'), { status: 503 });
  };
  dependencies.getPullRequest = async () => ({
    headRefOid: 'sha-B',
    number: 7,
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    body: '',
    state: 'OPEN',
  });
  dependencies.reviewAlreadyPosted = async ({ auth }) => {
    events.push(`reconcile:${auth.username}`);
    return false;
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 1);
  assert.deepEqual(result.failures.map(({ subject, note }) => ({ subject, note })), [
    { subject: 'owner/repo', note: 'search failed' },
  ]);
  assert.equal(result.outcomes[0].status, 're-reviewed');
  assert.deepEqual(
    events.filter((event) => /^(reconcile|review|post):/.test(event)),
    ['reconcile:work', 'review:learning:work', 'post:work'],
  );
  assert.equal(
    JSON.parse(await readFile(files.stateFile, 'utf8'))[
      prKey('owner/repo', 7, account)
    ].lastReviewedSha,
    'sha-B',
  );
});

test('a search failure only adds tracked state for its account and repository', async (t) => {
  const files = await fixture(t);
  const metadataCandidates = [];
  const account = { ...work, repositories: ['owner/repo'] };
  await saveState(files.stateFile, {
    [prKey('owner/repo', 7, account)]: {
      lastReviewedSha: 'sha-B',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    [prKey('other/repo', 8, account)]: {
      lastReviewedSha: 'sha-B',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    [prKey('owner/repo', 9, personal)]: {
      lastReviewedSha: 'sha-B',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });

  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => {
    throw Object.assign(new Error('HTTP 503: Service Unavailable'), { status: 503 });
  };
  dependencies.getPullRequest = async ({ repo, number }) => {
    metadataCandidates.push(`${repo}#${number}`);
    return {
      headRefOid: 'sha-B',
      number,
      title: 'PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(metadataCandidates, ['owner/repo#7']);
  assert.deepEqual(result.outcomes, []);
});

test('a foreign requested repository is rejected before metadata, review, or post', async (t) => {
  const files = await fixture(t);
  const calls = [];
  const account = { ...work, repositories: ['owner/repo'] };
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => [
    { repo: 'other/secret', number: 7 },
  ];
  dependencies.getPullRequest = async () => {
    calls.push('metadata');
    return {
      headRefOid: 'sha-1',
      number: 7,
      title: 'foreign PR',
      url: 'https://github.com/other/secret/pull/7',
      body: '',
      state: 'OPEN',
    };
  };
  dependencies.invokeMultiPassReview = async () => {
    calls.push('review');
    return { summary: 'reviewed', findings: [] };
  };
  dependencies.postReview = async () => {
    calls.push('post');
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.deepEqual(calls, []);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.outcomes, []);
});

test('foreign requested repositories do not consume the review safety cap', async (t) => {
  const files = await fixture(t);
  const metadataRepos = [];
  const account = { ...work, repositories: ['owner/repo'] };
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => [
    { repo: 'other/secret', number: 7 },
    ...Array.from({ length: MAX_REVIEWS_PER_POLL }, (_, index) => ({
      repo: 'owner/repo',
      number: index + 1,
    })),
  ];
  dependencies.getPullRequest = async ({ repo, number }) => {
    metadataRepos.push(`${repo}#${number}`);
    return {
      headRefOid: `sha-${number}`,
      number,
      title: `PR ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.reviewed, MAX_REVIEWS_PER_POLL);
  assert.equal(result.failed, true);
  assert.deepEqual(result.failures.map(({ note }) => note), ['search candidate rejected']);
  assert.equal(metadataRepos.includes('other/secret#7'), false);
  assert.equal(metadataRepos.length, MAX_REVIEWS_PER_POLL * 3);
});

test('malformed requested candidates are rejected while valid candidates are preserved', async (t) => {
  const files = await fixture(t);
  const metadataNumbers = [];
  const account = { ...work, repositories: ['owner/repo'] };
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => [
    null,
    { repo: 'owner/repo', number: 0 },
    { repo: 'owner/repo', number: 7 },
  ];
  dependencies.getPullRequest = async ({ number }) => {
    metadataNumbers.push(number);
    return {
      headRefOid: 'sha-1',
      number,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: 'OPEN',
    };
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 1);
  assert.deepEqual(result.failures.map(({ note }) => note), [
    'search candidate rejected',
    'search candidate rejected',
  ]);
  assert.deepEqual(metadataNumbers, [7, 7, 7]);
});

test('a tracked PR at the current head is skipped when discovery returns no requests', async (t) => {
  const files = await fixture(t);
  const events = [];
  const account = { ...work, repositories: ['owner/repo'] };
  await saveState(files.stateFile, {
    [prKey('owner/repo', 7, account)]: {
      lastReviewedSha: 'sha-B',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });

  const dependencies = successfulDependencies(events);
  dependencies.searchReviewRequestedPRs = async () => [];
  dependencies.getPullRequest = async () => ({
    headRefOid: 'sha-B',
    number: 7,
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    body: '',
    state: 'OPEN',
  });

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.outcomes, []);
  assert.deepEqual(events.filter((event) => event.startsWith('review:')), []);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
});

test('mixed-case existing state is recognized without reconciling or duplicating it', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const mixedKey = 'GITHUB.COM@WORK::OWNER/REPO#7';
  await writeFile(
    files.stateFile,
    JSON.stringify({
      [mixedKey]: {
        lastReviewedSha: 'sha-B',
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    }),
  );

  const dependencies = successfulDependencies([]);
  let reconciliationCalls = 0;
  dependencies.searchReviewRequestedPRs = async () => [{ repo: 'owner/repo', number: 7 }];
  dependencies.reviewAlreadyPosted = async () => {
    reconciliationCalls += 1;
    return true;
  };
  dependencies.getPullRequest = async () => ({
    headRefOid: 'sha-B',
    number: 7,
    title: 'PR',
    url: 'https://github.com/Owner/repo/pull/7',
    body: '',
    state: 'OPEN',
  });

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.outcomes, []);
  assert.equal(reconciliationCalls, 0);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(files.stateFile, 'utf8'))), [mixedKey]);
});

test('mixed-case scoped tracked state is discovered when requested search is empty', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  await writeFile(
    files.stateFile,
    JSON.stringify({
      'GITHUB.COM@WORK::OWNER/REPO#7': {
        lastReviewedSha: 'old-sha',
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    }),
  );

  const events = [];
  const dependencies = successfulDependencies(events);
  dependencies.searchReviewRequestedPRs = async () => [];
  dependencies.getPullRequest = async () => ({
    headRefOid: 'new-sha',
    number: 7,
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    body: '',
    state: 'OPEN',
  });

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(result.outcomes[0].status, 're-reviewed');
  assert.deepEqual(events.filter((event) => event.startsWith('review:')), [
    'review:learning:work',
  ]);
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(files.stateFile, 'utf8'))),
    ['github.com@work::owner/repo#7'],
  );
});

test('mixed-case scoped closed tracked state is retired', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  await writeFile(
    files.stateFile,
    JSON.stringify({
      'GITHUB.COM@WORK::OWNER/REPO#7': {
        lastReviewedSha: 'old-sha',
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    }),
  );

  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => [];
  dependencies.getPullRequest = async () => ({
    headRefOid: 'new-sha',
    number: 7,
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    body: '',
    state: 'CLOSED',
  });

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), {});
});

test('tracked state from another account or repository is not added to discovery', async (t) => {
  const files = await fixture(t);
  const events = [];
  const metadataNumbers = [];
  const account = { ...work, repositories: ['owner/repo'] };
  const enterprise = { hostname: 'enterprise.example.com', username: 'work' };
  await saveState(files.stateFile, {
    [prKey('owner/repo', 7, account)]: {
      lastReviewedSha: 'sha-B',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    [prKey('owner/repo', 8, personal)]: {
      lastReviewedSha: 'sha-B',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    [prKey('other/repo', 9, account)]: {
      lastReviewedSha: 'sha-B',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    [prKey('owner/repo', 10, enterprise)]: {
      lastReviewedSha: 'sha-B',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });

  const dependencies = successfulDependencies(events);
  dependencies.searchReviewRequestedPRs = async () => [];
  dependencies.getPullRequest = async ({ number }) => {
    metadataNumbers.push(number);
    return {
      headRefOid: 'sha-B',
      number,
      title: 'PR',
      url: `https://github.com/owner/repo/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.outcomes, []);
  assert.deepEqual(metadataNumbers, [7]);
  assert.deepEqual(events.filter((event) => event.startsWith('review:')), []);
});

test('fresh requested work is not starved by closed tracked backlog before the safety cap', async (t) => {
  const files = await fixture(t);
  const metadataCandidates = [];
  const account = {
    ...work,
    repositories: ['owner/old', 'owner/new'],
  };
  const trackedState = {};
  for (let number = 1; number <= 20; number += 1) {
    trackedState[prKey('owner/old', number, account)] = {
      lastReviewedSha: `sha-${number}`,
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    };
  }
  await saveState(files.stateFile, trackedState);

  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async ({ repo }) =>
    repo === 'owner/new' ? [{ repo, number: 99 }] : [];
  dependencies.getPullRequest = async ({ repo, number }) => {
    metadataCandidates.push(`${repo}#${number}`);
    return {
      headRefOid: `head-${number}`,
      number,
      title: `${repo} ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: repo === 'owner/old' ? 'CLOSED' : 'OPEN',
    };
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.ok(metadataCandidates.includes('owner/new#99'));
  assert.deepEqual(
    metadataCandidates.filter((candidate) => candidate.startsWith('owner/old#')),
    Array.from({ length: 20 }, (_, index) => `owner/old#${index + 1}`),
  );
  assert.deepEqual(
    result.outcomes.map(({ repo, number, status }) => ({ repo, number, status })),
    [{ repo: 'owner/new', number: 99, status: 'reviewed' }],
  );
});

test('a changed candidate in another repository receives safety-cap capacity', async (t) => {
  const files = await fixture(t);
  const account = {
    ...work,
    repositories: ['owner/busy', 'owner/starved'],
  };
  const reviewedCandidates = [];
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async ({ repo }) =>
    repo === 'owner/busy'
      ? Array.from({ length: MAX_REVIEWS_PER_POLL }, (_, index) => ({
        repo,
        number: index + 1,
      }))
      : [{ repo, number: 99 }];
  dependencies.postReview = async ({ repo, number }) => {
    reviewedCandidates.push(`${repo}#${number}`);
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, MAX_REVIEWS_PER_POLL);
  assert.ok(reviewedCandidates.includes('owner/starved#99'));
  assert.equal(reviewedCandidates.length, MAX_REVIEWS_PER_POLL);
  assert.equal(
    result.outcomes.find(({ repo, number }) => repo === 'owner/starved' && number === 99)?.status,
    'reviewed',
  );
  assert.match(
    result.failures.find(({ subject }) => subject === 'review queue')?.note ?? '',
    /1 candidate\(s\) deferred by safety limit/,
  );
});

test('no-op requested candidates do not starve a later changed candidate at the safety cap', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const state = {};
  for (let number = 1; number <= MAX_REVIEWS_PER_POLL; number += 1) {
    state[prKey('owner/repo', number, account)] = {
      lastReviewedSha: 'sha-current',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    };
  }
  state[prKey('owner/repo', MAX_REVIEWS_PER_POLL + 1, account)] = {
    lastReviewedSha: 'sha-previous',
    lastReviewedAt: '2026-08-05T00:00:00.000Z',
  };
  await saveState(files.stateFile, state);

  const metadataNumbers = [];
  const reviewedNumbers = [];
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async ({ repo }) =>
    Array.from({ length: MAX_REVIEWS_PER_POLL + 1 }, (_, index) => ({
      repo,
      number: index + 1,
    }));
  dependencies.getPullRequest = async ({ repo, number }) => {
    metadataNumbers.push(number);
    return {
      headRefOid: number === MAX_REVIEWS_PER_POLL + 1 ? 'sha-new' : 'sha-current',
      number,
      title: `PR ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };
  dependencies.invokeMultiPassReview = async ({ pr }) => {
    reviewedNumbers.push(pr.number);
    return { summary: 'reviewed', findings: [] };
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.deepEqual(
    result.outcomes.map(({ repo, number, status }) => ({ repo, number, status })),
    [{ repo: 'owner/repo', number: MAX_REVIEWS_PER_POLL + 1, status: 're-reviewed' }],
  );
  assert.deepEqual(reviewedNumbers, [MAX_REVIEWS_PER_POLL + 1]);
  assert.ok(metadataNumbers.includes(MAX_REVIEWS_PER_POLL + 1));
});

test('candidate metadata budget preserves later work and defers overflow', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const state = {};
  for (let number = 1; number <= MAX_CANDIDATE_METADATA_PER_POLL + 1; number += 1) {
    state[prKey('owner/repo', number, account)] = {
      lastReviewedSha: number <= MAX_REVIEWS_PER_POLL ? 'sha-current' : 'sha-previous',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    };
  }
  await saveState(files.stateFile, state);

  const metadataNumbers = [];
  let reconciliationCalls = 0;
  const reviewedNumbers = [];
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async ({ repo }) =>
    Array.from({ length: MAX_CANDIDATE_METADATA_PER_POLL + 1 }, (_, index) => ({
      repo,
      number: index + 1,
    }));
  dependencies.getPullRequest = async ({ repo, number }) => {
    metadataNumbers.push(number);
    return {
      headRefOid: number <= MAX_REVIEWS_PER_POLL ? 'sha-current' : 'sha-new',
      number,
      title: `PR ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };
  dependencies.reviewAlreadyPosted = async () => {
    reconciliationCalls += 1;
    return false;
  };
  dependencies.invokeMultiPassReview = async ({ pr }) => {
    reviewedNumbers.push(pr.number);
    return { summary: 'reviewed', findings: [] };
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, MAX_CANDIDATE_METADATA_PER_POLL - MAX_REVIEWS_PER_POLL);
  assert.deepEqual(reviewedNumbers, [
    ...Array.from(
      { length: MAX_CANDIDATE_METADATA_PER_POLL - MAX_REVIEWS_PER_POLL },
      (_, index) => MAX_REVIEWS_PER_POLL + index + 1,
    ),
  ]);
  assert.equal(reconciliationCalls, reviewedNumbers.length);
  assert.equal(metadataNumbers.includes(MAX_CANDIDATE_METADATA_PER_POLL + 1), false);
  assert.equal(
    metadataNumbers.length,
    MAX_CANDIDATE_METADATA_PER_POLL + reviewedNumbers.length * 2,
  );
  assert.equal(result.failures.length, 0);
  assert.equal(
    result.outcomes.find(({ subject }) => subject === 'review queue')?.status,
    'deferred',
  );
  assert.match(
    result.outcomes.find(({ subject }) => subject === 'review queue')?.note ?? '',
    /1 candidate\(s\) deferred by metadata budget/,
  );
});

test('candidate metadata overflow rotates its window so later PRs do not starve', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const state = {};
  for (let number = 1; number <= MAX_CANDIDATE_METADATA_PER_POLL + 1; number += 1) {
    state[prKey('owner/repo', number, account)] = {
      lastReviewedSha: number === MAX_CANDIDATE_METADATA_PER_POLL + 1
        ? 'old-sha'
        : 'current-sha',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    };
  }
  await saveState(files.stateFile, state);

  const metadataNumbers = [];
  const reviewedNumbers = [];
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async ({ repo }) =>
    Array.from({ length: MAX_CANDIDATE_METADATA_PER_POLL + 1 }, (_, index) => ({
      repo,
      number: index + 1,
    }));
  dependencies.getPullRequest = async ({ repo, number }) => {
    metadataNumbers.push(number);
    return {
      headRefOid: number === MAX_CANDIDATE_METADATA_PER_POLL + 1
        ? 'new-sha'
        : 'current-sha',
      number,
      title: `PR ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };
  dependencies.invokeMultiPassReview = async ({ pr }) => {
    reviewedNumbers.push(pr.number);
    return { summary: 'reviewed', findings: [] };
  };

  const first = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });
  assert.equal(first.failed, false);
  assert.equal(first.reviewed, 0);
  assert.deepEqual(
    metadataNumbers,
    Array.from({ length: MAX_CANDIDATE_METADATA_PER_POLL }, (_, index) => index + 1),
  );

  const second = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });
  assert.equal(second.failed, false);
  assert.equal(second.reviewed, 1);
  assert.equal(metadataNumbers[MAX_CANDIDATE_METADATA_PER_POLL], MAX_CANDIDATE_METADATA_PER_POLL + 1);
  assert.deepEqual(reviewedNumbers, [MAX_CANDIDATE_METADATA_PER_POLL + 1]);
});

test('already-posted reconciliations release safety capacity for a later changed PR', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const state = {};
  for (let number = 1; number <= MAX_REVIEWS_PER_POLL + 1; number += 1) {
    state[prKey('owner/repo', number, account)] = {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    };
  }
  await saveState(files.stateFile, state);

  const reviewedNumbers = [];
  const postedNumbers = [];
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async ({ repo }) =>
    Array.from({ length: MAX_REVIEWS_PER_POLL + 1 }, (_, index) => ({
      repo,
      number: index + 1,
    }));
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'new-sha',
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  dependencies.reviewAlreadyPosted = async ({ number }) => number <= MAX_REVIEWS_PER_POLL;
  dependencies.invokeMultiPassReview = async ({ pr }) => {
    reviewedNumbers.push(pr.number);
    return { summary: 'reviewed', findings: [] };
  };
  dependencies.postReview = async ({ number, scheduleMutation }) =>
    scheduleMutation(async () => { postedNumbers.push(number); });

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, MAX_REVIEWS_PER_POLL + 1);
  assert.deepEqual(reviewedNumbers, [MAX_REVIEWS_PER_POLL + 1]);
  assert.deepEqual(postedNumbers, [MAX_REVIEWS_PER_POLL + 1]);
  assert.equal(result.failures.length, 0);
});

test('closed tracked backlog does not consume actionable safety capacity', async (t) => {
  const files = await fixture(t);
  const metadataCandidates = [];
  const account = { ...work, repositories: ['owner/repo'] };
  const trackedState = {};
  for (let number = 1; number <= 21; number += 1) {
    trackedState[prKey('owner/repo', number, account)] = {
      lastReviewedSha: `old-${number}`,
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    };
  }
  await saveState(files.stateFile, trackedState);

  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => [];
  dependencies.getPullRequest = async ({ number }) => {
    metadataCandidates.push(number);
    return {
      headRefOid: `new-${number}`,
      number,
      title: `PR ${number}`,
      url: `https://github.com/owner/repo/pull/${number}`,
      body: '',
      state: number === 21 ? 'OPEN' : number % 2 === 0 ? 'MERGED' : 'CLOSED',
    };
  };

  const firstPoll = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(firstPoll.failed, false);
  assert.equal(firstPoll.reviewed, 1);
  assert.deepEqual(metadataCandidates, [
    ...Array.from({ length: 20 }, (_, i) => i + 1),
    21,
    21,
    21,
  ]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(files.stateFile, 'utf8'))), [
    prKey('owner/repo', 21, account),
  ]);

  const secondPoll = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(secondPoll.failed, false);
  assert.equal(secondPoll.reviewed, 0);
  assert.deepEqual(secondPoll.outcomes, []);
  assert.deepEqual(metadataCandidates.slice(23), [21]);
  const persisted = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.deepEqual(Object.keys(persisted), [prKey('owner/repo', 21, account)]);
  assert.equal(persisted[prKey('owner/repo', 21, account)].lastReviewedSha, 'new-21');
  assert.equal(typeof persisted[prKey('owner/repo', 21, account)].lastReviewedAt, 'string');
});

test('failed closed-state cleanup reports a failure and preserves the tracked key', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const closedKey = prKey('owner/repo', 1, account);
  const openKey = prKey('owner/repo', 2, account);
  await saveState(files.stateFile, {
    [closedKey]: {
      lastReviewedSha: 'old-1',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    [openKey]: {
      lastReviewedSha: 'old-2',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });

  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => [];
  dependencies.getPullRequest = async ({ number }) => ({
    headRefOid: `new-${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/owner/repo/pull/${number}`,
    body: '',
    state: number === 1 ? 'CLOSED' : 'OPEN',
  });
  let saveCalls = 0;
  dependencies.saveState = async (...args) => {
    saveCalls += 1;
    if (saveCalls === 1) throw new Error('disk full');
    return saveState(...args);
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 1);
  assert.deepEqual(
    result.failures.map(({ repo, number, note }) => ({ repo, number, note })),
    [{ repo: 'owner/repo', number: 1, note: 'tracking cleanup failed' }],
  );
  const persisted = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.equal(persisted[closedKey].lastReviewedSha, 'old-1');
  assert.equal(persisted[openKey].lastReviewedSha, 'new-2');
});

test('failed cleanup of a mixed-case alias preserves the legacy file without adding a key', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const mixedKey = 'GITHUB.COM@WORK::OWNER/REPO#1';
  const initialState = {
    [mixedKey]: {
      lastReviewedSha: 'old-1',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  };
  await writeFile(files.stateFile, JSON.stringify(initialState));

  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => [];
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'new-1',
    number,
    title: 'PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'CLOSED',
  });
  dependencies.saveState = async () => {
    throw new Error('disk full');
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.deepEqual(
    result.failures.map(({ repo, number, note }) => ({ repo, number, note })),
    [{ repo: 'owner/repo', number: 1, note: 'tracking cleanup failed' }],
  );
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
});

test('requested and tracked copies of one PR are de-duplicated with requested source priority', async (t) => {
  const files = await fixture(t);
  const metadataNumbers = [];
  const account = { ...work, repositories: ['owner/repo'] };
  await saveState(files.stateFile, {
    [prKey('owner/repo', 7, account)]: {
      lastReviewedSha: 'sha-old',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });

  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => [{ repo: 'owner/repo', number: 7 }];
  dependencies.getPullRequest = async ({ number }) => {
    metadataNumbers.push(number);
    return {
      headRefOid: 'sha-new',
      number,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: 'OPEN',
    };
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(metadataNumbers.length, 3);
  assert.deepEqual(new Set(metadataNumbers), new Set([7]));
  assert.equal(result.outcomes[0].status, 're-reviewed');
});

test('requested and tracked repository aliases are de-duplicated while API spelling is preserved', async (t) => {
  const files = await fixture(t);
  const metadataRepos = [];
  const account = { ...work, repositories: ['owner/repo'] };
  await writeFile(
    files.stateFile,
    JSON.stringify({
      'github.com@work::OWNER/rePO#7': {
        lastReviewedSha: 'sha-old',
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    }),
  );

  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => [{ repo: 'Owner/repo', number: 7 }];
  dependencies.getPullRequest = async ({ repo }) => {
    metadataRepos.push(repo);
    return {
      headRefOid: 'sha-new',
      number: 7,
      title: 'PR',
      url: 'https://github.com/Owner/repo/pull/7',
      body: '',
      state: 'OPEN',
    };
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.reviewed, 1);
  assert.deepEqual(metadataRepos, ['Owner/repo', 'Owner/repo', 'Owner/repo']);
  assert.equal(result.outcomes[0].repo, 'Owner/repo');
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(files.stateFile, 'utf8'))),
    ['github.com@work::owner/repo#7'],
  );
});

test('one unavailable account does not block healthy account work and marks failure', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  dependencies.resolveGitHubAuth = async (account) => {
    if (account.username === 'work') throw new Error('credential expired');
    return { ...account, token: 'safe-token' };
  };

  const result = await pollOnce({
    config: config(),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'authentication failed');
  assert.equal(events.includes('post:personal'), true);
  assert.equal(events.includes('post:work'), false);
  const logRecords = (await readFile(files.logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(
    logRecords.some(
      (record) =>
        record.account === 'work@github.com' &&
        /account unavailable/.test(record.message),
    ),
    true,
  );
});

test('missing config-wide AI-processing consent blocks every account before authentication', async (t) => {
  const files = await fixture(t);
  const events = [];
  const result = await pollOnce({
    config: { ...config([work]), aiProcessingConsent: null },
    ...files,
    dependencies: successfulDependencies(events),
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.equal(result.failures[0].note, 'AI-processing consent required');
  assert.deepEqual(events, []);
});

for (const pullRequestState of ['CLOSED', 'MERGED']) {
  test(`a ${pullRequestState.toLowerCase()} PR returned by search never reaches the reviewer`, async (t) => {
    const files = await fixture(t);
    const events = [];
    const dependencies = successfulDependencies(events);
    dependencies.getPullRequest = async () => ({
      headRefOid: 'sha-1',
      number: 7,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: pullRequestState,
    });

    const result = await pollOnce({
      config: config([work]),
      ...files,
      dependencies,
    });

    assert.deepEqual(result, {
      failed: false,
      reviewed: 0,
      outcomes: [],
      failures: [],
    });
    assert.deepEqual(events.filter((event) => event.startsWith('review:')), []);
    assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
    await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
  });
}

test('a PR failure leaves its state untouched while another account completes', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  dependencies.invokeMultiPassReview = async ({ learnings }) => {
    if (learnings.includes('work')) throw new Error('review failed');
    return { summary: 'reviewed', findings: [] };
  };

  const result = await pollOnce({
    config: config(),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.deepEqual(Object.keys(state), ['github.com@personal::owner/repo#7']);
});

test('the reviewer receives only the selected account credential environment', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  let reviewerEnvironment;
  let githubAccess;
  dependencies.invokeMultiPassReview = async ({ environment, githubAccess: access }) => {
    reviewerEnvironment = environment;
    githubAccess = access;
    return { summary: 'reviewed', findings: [] };
  };

  await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(reviewerEnvironment.GH_TOKEN, 'work-token');
  assert.equal(reviewerEnvironment.GH_HOST, 'github.com');
  assert.equal(reviewerEnvironment.GH_PROMPT_DISABLED, '1');
  assert.equal(
    reviewerEnvironment.OPENMERGELENS_GITHUB_ACCOUNT,
    'work@github.com',
  );
  assert.equal(typeof githubAccess.scheduleGitHubOperation, 'function');
});

test('the poller forwards the selected model and reasoning level to the reviewer', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  dependencies.invokeMultiPassReview = async ({ model }) => {
    events.push(JSON.stringify(model));
    return { summary: 'reviewed', findings: [] };
  };

  const result = await pollOnce({
    config: {
      ...config([work]),
      model: { id: 'gpt-5.6', reasoningEffort: 'high' },
    },
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.deepEqual(
    events.filter((event) => event.startsWith('{')),
    [JSON.stringify({ id: 'gpt-5.6', reasoningEffort: 'high' })],
  );
});

test('the poller forwards the configured reviewer timeout', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  let reviewerTimeoutMs;
  dependencies.invokeMultiPassReview = async ({ timeoutMs }) => {
    reviewerTimeoutMs = timeoutMs;
    return { summary: 'reviewed', findings: [] };
  };

  const result = await pollOnce({
    config: {
      ...config([work]),
      reviewTimeoutMs: 15 * 60 * 1000,
    },
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(reviewerTimeoutMs, 15 * 60 * 1000);
});

test('the poller supplies reviewer retry diagnostics with PR context', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  let onDiagnostic;
  dependencies.invokeMultiPassReview = async (options) => {
    ({ onDiagnostic } = options);
    return { summary: 'reviewed', findings: [] };
  };

  await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(typeof onDiagnostic, 'function');
  assert.doesNotThrow(() => onDiagnostic('retrying semantic inspection'));
});

test('a diff larger than two MiB still reaches the reviewer and posting anchor flow', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  dependencies.getPullRequestDiff = async () =>
    `@@ -0,0 +1 @@\n+${'x'.repeat(2 * 1024 * 1024)}\n`;
  let reviewed = false;
  let postedDiffBytes = 0;
  dependencies.invokeMultiPassReview = async () => {
    reviewed = true;
    return { summary: 'reviewed', findings: [] };
  };
  dependencies.postReview = async ({ diff }) => {
    postedDiffBytes = Buffer.byteLength(diff, 'utf8');
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(reviewed, true);
  assert.ok(postedDiffBytes > 2 * 1024 * 1024);
});

test('new commits arriving during review prevent a stale review from posting', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  let metadataCalls = 0;
  dependencies.getPullRequest = async () => {
    metadataCalls += 1;
    return {
      headRefOid: metadataCalls === 1 ? 'sha-1' : 'sha-2',
      number: 7,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: 'OPEN',
    };
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.failures, []);
  assert.equal(result.outcomes[0].status, 'deferred');
  assert.equal(
    result.outcomes[0].note,
    'new commits during review; will retry next poll',
  );
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
});

for (const [label, confirmationMetadata] of [
  ['null', null],
  ['missing headRefOid', {
    number: 1,
    title: 'PR 1',
    url: 'https://github.com/owner/repo/pull/1',
    body: '',
    state: 'OPEN',
  }],
]) {
  test(`malformed ${label} confirmation fails one candidate and continues`, async (t) => {
    const files = await fixture(t);
    const account = { ...work, repositories: ['owner/repo'] };
    const initialEntry = {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    };
    await saveState(files.stateFile, {
      [prKey('owner/repo', 1, account)]: initialEntry,
    });

    const events = [];
    const dependencies = successfulDependencies(events);
    dependencies.searchReviewRequestedPRs = async () => [
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
    ];
    const metadataCalls = new Map();
    dependencies.getPullRequest = async ({ number }) => {
      const calls = (metadataCalls.get(number) ?? 0) + 1;
      metadataCalls.set(number, calls);
      if (number === 1 && calls === 2) return confirmationMetadata;
      return {
        headRefOid: `sha-${number}`,
        number,
        title: `PR ${number}`,
        url: `https://github.com/owner/repo/pull/${number}`,
        body: '',
        state: 'OPEN',
      };
    };

    const result = await pollOnce({
      config: config([account]),
      ...files,
      dependencies,
    });

    assert.equal(result.failed, true);
    assert.equal(result.reviewed, 1);
    assert.deepEqual(
      result.failures.map(({ repo, number, note }) => ({ repo, number, note })),
      [{ repo: 'owner/repo', number: 1, note: 'head verification failed' }],
    );
    assert.deepEqual(
      result.outcomes.map(({ status, number }) => ({ status, number })),
      [{ status: 'reviewed', number: 2 }],
    );
    assert.deepEqual(
      events.filter((event) => event.startsWith('post:')),
      ['post:work'],
    );

    const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
    assert.deepEqual(state[prKey('owner/repo', 1, account)], initialEntry);
    assert.equal(state[prKey('owner/repo', 2, account)].lastReviewedSha, 'sha-2');
  });
}

test('new commits at the mutation boundary defer without posting or recording', async (t) => {
  const files = await fixture(t);
  const events = [];
  const key = 'github.com@work::owner/repo#7';
  const initialState = {
    [key]: {
      lastReviewedSha: 'prior-sha',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);

  const dependencies = successfulDependencies(events);
  let metadataCalls = 0;
  let saveCalls = 0;
  dependencies.getPullRequest = async () => {
    metadataCalls += 1;
    return {
      headRefOid: metadataCalls === 3 ? 'sha-2' : 'sha-1',
      number: 7,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: 'OPEN',
    };
  };
  dependencies.saveState = async (...args) => {
    saveCalls += 1;
    return saveState(...args);
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(metadataCalls, 3);
  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.failures, []);
  assert.equal(result.outcomes[0].status, 'deferred');
  assert.equal(
    result.outcomes[0].note,
    'new commits during review; will retry next poll',
  );
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  assert.equal(saveCalls, 0);
  assert.deepEqual(
    JSON.parse(await readFile(files.stateFile, 'utf8')),
    initialState,
  );
});

test('a head change during cadence wait defers without posting or recording', async (t) => {
  const files = await fixture(t);
  const events = [];
  const key = 'github.com@work::owner/repo#7';
  const initialState = {
    [key]: {
      lastReviewedSha: 'prior-sha',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);

  let head = 'sha-1';
  let cadenceWaits = 0;
  let saveCalls = 0;
  const dependencies = successfulDependencies(events);
  dependencies.createGitHubMutationCadence = () => ({
    run: async (operation, { beforeStart } = {}) => {
      cadenceWaits += 1;
      await new Promise((resolve) => setImmediate(resolve));
      head = 'sha-2';
      if (beforeStart) await beforeStart();
      return operation();
    },
  });
  dependencies.getPullRequest = async () => ({
    headRefOid: head,
    number: 7,
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    body: '',
    state: 'OPEN',
  });
  dependencies.saveState = async (...args) => {
    saveCalls += 1;
    return saveState(...args);
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(cadenceWaits, 1);
  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.equal(result.outcomes[0].status, 'deferred');
  assert.equal(
    result.outcomes[0].note,
    'new commits during review; will retry next poll',
  );
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  assert.equal(saveCalls, 0);
  assert.deepEqual(
    JSON.parse(await readFile(files.stateFile, 'utf8')),
    initialState,
  );
});

test('positive post reconciliation cannot swallow a stale boundary sentinel', async (t) => {
  const files = await fixture(t);
  const events = [];
  const key = 'github.com@work::owner/repo#7';
  const initialState = {
    [key]: {
      lastReviewedSha: 'prior-sha',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);

  const dependencies = successfulDependencies(events);
  let metadataCalls = 0;
  let saveCalls = 0;
  const requestMethods = [];
  dependencies.getPullRequest = async () => {
    metadataCalls += 1;
    return {
      headRefOid: metadataCalls === 3 ? 'sha-2' : 'sha-1',
      number: 7,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: 'OPEN',
    };
  };
  dependencies.postReview = async (options) => productionPostReview({
    ...options,
    request: async (args) => {
      requestMethods.push(args[args.indexOf('--method') + 1]);
      throw new Error('unexpected GitHub request after boundary rejection');
    },
  });
  dependencies.saveState = async (...args) => {
    saveCalls += 1;
    return saveState(...args);
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(metadataCalls, 3);
  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.outcomes[0], {
    status: 'deferred',
    repo: 'owner/repo',
    number: 7,
    account: 'work@github.com',
    hostname: 'github.com',
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    note: 'new commits during review; will retry next poll',
  });
  assert.deepEqual(requestMethods, []);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  assert.equal(saveCalls, 0);
  assert.deepEqual(
    JSON.parse(await readFile(files.stateFile, 'utf8')),
    initialState,
  );
});

test('a PR closed at the mutation boundary is skipped without posting or recording', async (t) => {
  const files = await fixture(t);
  const events = [];
  const key = 'github.com@work::owner/repo#7';
  const initialState = {
    [key]: {
      lastReviewedSha: 'prior-sha',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);

  const dependencies = successfulDependencies(events);
  let metadataCalls = 0;
  let saveCalls = 0;
  dependencies.getPullRequest = async () => {
    metadataCalls += 1;
    return {
      headRefOid: 'sha-1',
      number: 7,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: metadataCalls === 3 ? 'CLOSED' : 'OPEN',
    };
  };
  dependencies.saveState = async (...args) => {
    saveCalls += 1;
    return saveState(...args);
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(metadataCalls, 3);
  assert.deepEqual(result, {
    failed: false,
    reviewed: 0,
    outcomes: [],
    failures: [],
  });
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  assert.equal(saveCalls, 0);
  assert.deepEqual(
    JSON.parse(await readFile(files.stateFile, 'utf8')),
    initialState,
  );
});

test('a dry run defers when the PR head changes without printing stale output', async (t) => {
  const files = await fixture(t);
  const events = [];
  const initialState = {
    'github.com@work::owner/repo#7': {
      lastReviewedSha: 'prior-sha',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);

  const dependencies = successfulDependencies(events);
  let metadataCalls = 0;
  let saveCalls = 0;
  dependencies.getPullRequest = async () => {
    metadataCalls += 1;
    return {
      headRefOid: metadataCalls === 1 ? 'sha-1' : 'sha-2',
      number: 7,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: 'OPEN',
    };
  };
  dependencies.saveState = async (...args) => {
    saveCalls += 1;
    return saveState(...args);
  };
  dependencies.invokeMultiPassReview = async () => {
    events.push('review:stale');
    return { summary: 'stale summary', findings: [] };
  };
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dryRun: true,
    dependencies,
  });

  assert.equal(metadataCalls, 2);
  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.outcomes[0], {
    status: 'deferred',
    repo: 'owner/repo',
    number: 7,
    account: 'work@github.com',
    hostname: 'github.com',
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    note: 'new commits during review; will retry next poll',
  });
  assert.equal(events.filter((event) => event.startsWith('review:')).length, 1);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  assert.doesNotMatch(output.join('\n'), /stale summary/);
  assert.equal(saveCalls, 0);
  assert.deepEqual(
    JSON.parse(await readFile(files.stateFile, 'utf8')),
    initialState,
  );
});

test('a PR closed during review is not posted or recorded', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  let metadataCalls = 0;
  dependencies.getPullRequest = async () => {
    metadataCalls += 1;
    return {
      headRefOid: 'sha-1',
      number: 7,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: metadataCalls === 1 ? 'OPEN' : 'CLOSED',
    };
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.deepEqual(result, {
    failed: false,
    reviewed: 0,
    outcomes: [],
    failures: [],
  });
  assert.equal(events.filter((event) => event.startsWith('review:')).length, 1);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
});

test('account-filtered dry runs invoke only that reviewer and never write state', async (t) => {
  const files = await fixture(t);
  const events = [];
  const result = await pollOnce({
    config: config(),
    ...files,
    dryRun: true,
    accountSelector: { hostname: 'github.com', username: 'personal' },
    dependencies: successfulDependencies(events),
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(result.outcomes[0].status, 'dry-run');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(events.filter((event) => event.startsWith('search:')), [
    'search:personal:owner/repo',
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
});

test('a dry run reports an existing review without reconciling or writing state', async (t) => {
  const files = await fixture(t);
  const events = [];
  let saveCalls = 0;
  const dependencies = successfulDependencies(events);
  dependencies.reviewAlreadyPosted = async () => true;
  dependencies.saveState = async (...args) => {
    saveCalls += 1;
    return saveState(...args);
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dryRun: true,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.deepEqual(result.outcomes[0], {
    status: 'dry-run',
    repo: 'owner/repo',
    number: 7,
    account: 'work@github.com',
    hostname: 'github.com',
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    note: 'existing review detected; state not changed in dry run',
  });
  assert.deepEqual(result.failures, []);
  assert.equal(saveCalls, 0);
  assert.deepEqual(events.filter((event) => event.startsWith('review:')), []);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
});

test('a dry run classifies findings against the diff without posting or writing state', async (t) => {
  const files = await fixture(t);
  const events = [];
  let postCalls = 0;
  let saveCalls = 0;
  const dependencies = successfulDependencies(events);
  dependencies.getPullRequestDiff = async () =>
    '+++ b/changed.js\n@@ -0,0 +1 @@\n+line\n';
  dependencies.invokeMultiPassReview = async () => ({
    summary: 'review summary',
    findings: [
      {
        path: 'changed.js',
        line: 1,
        severity: 'major',
        comment: 'anchored',
      },
      {
        path: 'missing.js',
        line: 99,
        severity: 'major',
        comment: 'unanchored',
      },
    ],
  });
  dependencies.postReview = async () => {
    postCalls += 1;
  };
  dependencies.saveState = async () => {
    saveCalls += 1;
  };
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dryRun: true,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(result.outcomes[0].status, 'dry-run');
  assert.deepEqual(result.failures, []);
  assert.match(output.join('\n'), /1 inline finding\(s\); 1 summary-only finding\(s\)/);
  assert.equal(postCalls, 0);
  assert.equal(events.filter((event) => event === 'github:scheduled').length, 6);
  assert.equal(saveCalls, 0);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
});

test('a dry run does not harden or rewrite an existing state file', {
  skip: process.platform === 'win32',
}, async (t) => {
  const files = await fixture(t);
  const initialState = {
    [prKey('owner/repo', 7, work)]: {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  };
  const initialContent = `${JSON.stringify(initialState)}\n`;
  await writeFile(files.stateFile, initialContent);
  await chmod(files.stateFile, 0o644);

  const events = [];
  const result = await pollOnce({
    config: config([work]),
    ...files,
    dryRun: true,
    dependencies: successfulDependencies(events),
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(result.outcomes[0].status, 'dry-run');
  assert.equal((await stat(files.stateFile)).mode & 0o777, 0o644);
  assert.equal(await readFile(files.stateFile, 'utf8'), initialContent);
});

for (const [label, review, expectedError] of [
  [
    'invalid finding fields',
    {
      summary: 'review summary',
      findings: [{ path: 'changed.js', line: 1, severity: 'urgent', comment: 'unsafe' }],
    },
    /invalid or unsafe finding/,
  ],
  [
    'oversized summary',
    { summary: 's'.repeat(16_001), findings: [] },
    /summary exceeds 16000 characters/,
  ],
]) {
  test(`a dry run reports ${label} as a failure without mutation`, async (t) => {
    const files = await fixture(t);
    const events = [];
    let postCalls = 0;
    let saveCalls = 0;
    const dependencies = successfulDependencies(events);
    dependencies.invokeMultiPassReview = async () => review;
    dependencies.postReview = async () => {
      postCalls += 1;
    };
    dependencies.saveState = async () => {
      saveCalls += 1;
    };

    const result = await pollOnce({
      config: config([work]),
      ...files,
      dryRun: true,
      dependencies,
    });

    assert.equal(result.failed, true);
    assert.equal(result.reviewed, 0);
    assert.deepEqual(result.outcomes, []);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].status, 'failed');
    assert.equal(result.failures[0].note, 'dry-run validation failed');
    const logRecords = (await readFile(files.logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      logRecords.some(
        (record) =>
          expectedError.test(record.message) ||
          expectedError.test(record.error?.message ?? ''),
      ),
      true,
    );
    assert.equal(postCalls, 0);
    assert.equal(events.filter((event) => event === 'github:scheduled').length, 6);
    assert.equal(saveCalls, 0);
    await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
  });
}

test('a posted review is reconciled after state persistence fails without reposting', async (t) => {
  const files = await fixture(t);
  const events = [];
  const postedMarkers = new Set();
  let failNextSave = true;
  const dependencies = successfulDependencies(events);
  dependencies.postReview = async ({ marker }) => {
    events.push('post');
    postedMarkers.add(marker);
  };
  dependencies.reviewAlreadyPosted = async ({ marker }) => postedMarkers.has(marker);
  dependencies.saveState = async (...args) => {
    if (failNextSave) {
      failNextSave = false;
      throw new Error('disk unavailable');
    }
    return saveState(...args);
  };

  const first = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });
  assert.equal(first.failed, true);
  assert.equal(first.reviewed, 0);
  assert.equal(first.failures[0].status, 'tracking-failed');
  assert.equal(first.failures[0].note, 'will reconcile');
  assert.deepEqual(events.filter((event) => event === 'post'), ['post']);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });

  const second = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });
  assert.equal(second.failed, false);
  assert.equal(second.reviewed, 1);
  assert.equal(second.outcomes[0].status, 'recovered');
  assert.deepEqual(second.failures, []);
  assert.deepEqual(events.filter((event) => event === 'post'), ['post']);
  assert.equal(events.filter((event) => event.startsWith('review:')).length, 1);

  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.equal(
    state['github.com@work::owner/repo#7'].lastReviewedSha,
    'sha-1',
  );
});

test('new commits are reported as a re-review while an unchanged head is a no-op', async (t) => {
  const files = await fixture(t);
  const key = 'github.com@work::owner/repo#7';
  await saveState(files.stateFile, {
    [key]: {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    },
  });

  const firstEvents = [];
  const first = await pollOnce({
    config: config([work]),
    ...files,
    dependencies: successfulDependencies(firstEvents),
  });
  assert.equal(first.outcomes[0].status, 're-reviewed');

  const secondEvents = [];
  const second = await pollOnce({
    config: config([work]),
    ...files,
    dependencies: successfulDependencies(secondEvents),
  });
  assert.deepEqual(second, {
    failed: false,
    reviewed: 0,
    outcomes: [],
    failures: [],
  });
  assert.deepEqual(
    secondEvents.filter((event) => event.startsWith('review:')),
    [],
  );
});

test('global review admission caps large concurrent reviews below reviewBatchSize', async (t) => {
  const files = await fixture(t);
  const stats = {
    activeDiffs: 0,
    maxActiveDiffs: 0,
    activeReviewers: 0,
    maxActiveReviewers: 0,
    activePosts: 0,
    maxActivePosts: 0,
    diffStarts: 0,
    reviewerStarts: 0,
    postStarts: 0,
  };

  const result = await pollOnce({
    config: { ...config([work]), reviewBatchSize: 10 },
    ...files,
    dependencies: admissionStressDependencies(null, stats),
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 8);
  assert.equal(stats.diffStarts, 8);
  assert.equal(stats.reviewerStarts, 8);
  assert.equal(stats.postStarts, 8);
  assert.ok(stats.maxActiveDiffs <= MAX_CONCURRENT_REVIEW_ADMISSIONS);
  assert.ok(stats.maxActiveReviewers <= MAX_CONCURRENT_REVIEW_ADMISSIONS);
  assert.ok(stats.maxActivePosts <= MAX_CONCURRENT_REVIEW_ADMISSIONS);
});

for (const failureStage of ['diff', 'reviewer', 'post']) {
  test(`global review admission releases its permit after ${failureStage} failure`, async (t) => {
    const files = await fixture(t);
    const stats = {
      activeDiffs: 0,
      maxActiveDiffs: 0,
      activeReviewers: 0,
      maxActiveReviewers: 0,
      activePosts: 0,
      maxActivePosts: 0,
      diffStarts: 0,
      reviewerStarts: 0,
      postStarts: 0,
    };

    const result = await pollOnce({
      config: { ...config([work]), reviewBatchSize: 10 },
      ...files,
      dependencies: admissionStressDependencies(failureStage, stats),
    });

    assert.equal(result.failed, true);
    assert.equal(result.reviewed, 7);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].status, 'failed');
    assert.ok(stats.diffStarts >= 7);
    assert.ok(stats.maxActiveDiffs <= MAX_CONCURRENT_REVIEW_ADMISSIONS);
    assert.ok(stats.maxActiveReviewers <= MAX_CONCURRENT_REVIEW_ADMISSIONS);
    assert.ok(stats.maxActivePosts <= MAX_CONCURRENT_REVIEW_ADMISSIONS);
  });
}

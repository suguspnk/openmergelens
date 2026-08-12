import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pollOnce } from '../lib/poller.mjs';
import {
  postReview as productionPostReview,
  reviewAlreadyPosted as productionReviewAlreadyPosted,
  searchReviewRequestedPRs as productionSearchReviewRequestedPRs,
} from '../lib/github.mjs';
import {
  createGitHubMutationCadence,
  createGitHubMutationQueue,
} from '../lib/github-mutation-queue.mjs';
import {
  MAX_CONFIGURED_REVIEW_SCOPES,
  MAX_CONCURRENT_REVIEW_ADMISSIONS,
  MAX_REVIEW_STATE_ENTRIES,
  MAX_REVIEWS_PER_POLL,
  MAX_STATE_GC_CHECKS_PER_POLL,
  MAX_STATE_FILE_BYTES,
} from '../lib/security-limits.mjs';
import { MAX_CANDIDATE_METADATA_PER_POLL } from '../lib/poller.mjs';
import {
  prKey,
  reviewStateGcAfterKey,
  saveState,
  serializeState,
  STATE_METADATA_KEY,
} from '../lib/state.mjs';
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

const validatedTestSearchResults = new WeakSet();
const nonCanonicalDecimalEncodings = [
  ['empty', ''],
  ['whitespace-only', ' '],
  ['leading-whitespace', ' 1'],
  ['trailing-whitespace', '1 '],
  ['exponent', '1e0'],
  ['positive-sign', '+1'],
  ['negative-sign', '-1'],
  ['decimal', '1.0'],
  ['leading-zero', '01'],
  ['unsafe-integer', '9007199254740992'],
];
const malformedProductionSearchNumberOutputs = [
  ...nonCanonicalDecimalEncodings.map(([label, encoding]) => ({
    label: `${label} total_count`,
    output: `meta|${encoding}|false\n`,
  })),
  ...[
    ...nonCanonicalDecimalEncodings,
    ['zero', '0'],
  ].map(([label, encoding]) => ({
    label: `${label} PR number`,
    output:
      'meta|1|false\n' +
      `https://api.github.com/repos/owner/repo|${encoding}\n`,
  })),
];

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

function completeSearch(candidates) {
  Object.defineProperty(candidates, 'complete', { value: true });
  validatedTestSearchResults.add(candidates);
  return candidates;
}

function isValidatedTestSearchResult(candidates) {
  return validatedTestSearchResults.has(candidates);
}

function mockProductionSearchOutput(t, output) {
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write() {},
      end() {},
    };
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(output));
      child.emit('close', 0);
    });
    return child;
  });
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

test('configured scope universe is bounded before state or external work', async (t) => {
  const files = await fixture(t);
  const repositories = Array.from(
    { length: MAX_CONFIGURED_REVIEW_SCOPES + 1 },
    (_, index) => `owner/repo-${index}`,
  );
  let loadCalls = 0;
  let authCalls = 0;

  await assert.rejects(
    pollOnce({
      config: {
        ...config([work]),
        githubAccounts: [{ ...work, repositories }],
      },
      ...files,
      dependencies: {
        loadState: async () => {
          loadCalls += 1;
          return {};
        },
        resolveGitHubAuth: async () => {
          authCalls += 1;
          return {};
        },
      },
    }),
    new RegExp(`exceeds ${MAX_CONFIGURED_REVIEW_SCOPES} configured review scopes`, 'u'),
  );
  assert.equal(loadCalls, 0);
  assert.equal(authCalls, 0);
});

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
    isValidatedReviewRequestSearchResult: isValidatedTestSearchResult,
    searchReviewRequestedPRs: async ({ username, repo }) => {
      events.push(`search:${username}:${repo}`);
      return completeSearch([{ repo, number: 7 }]);
    },
    getPullRequest: async () => ({
      headRefOid: 'sha-1',
      number: 7,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: 'OPEN',
    }),
    getPullRequestForStateGc: async ({ repo, number }) => ({
      headRefOid: `tracked-sha-${number}`,
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
    isValidatedReviewRequestSearchResult: isValidatedTestSearchResult,
    searchReviewRequestedPRs: async ({ repo }) =>
      completeSearch(Array.from({ length: candidateCount }, (_, index) => ({
        repo,
        number: index + 1,
      }))),
    getPullRequest: async ({ repo, number }) => ({
      headRefOid: `sha-${number}`,
      number,
      title: `PR ${number}`,
      url: `https://github.com/owner/repo/pull/${number}`,
      body: '',
      state: 'OPEN',
      repo,
    }),
    getPullRequestForStateGc: async ({ repo, number }) => ({
      headRefOid: `tracked-sha-${number}`,
      number,
      title: `Tracked PR ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
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
    hasActiveReviewRequest: async () => true,
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
    16,
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
  assert.equal(state['github.com@personal::owner/repo#7'].reviewMarkerVersion, 1);
  assert.equal(state['github.com@work::owner/repo#7'].reviewMarkerVersion, 1);
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
    dependencies.searchReviewRequestedPRs = async () => completeSearch([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
    ]);
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

test('invalid legacy state fails before authentication and remains untouched', async (t) => {
  const files = await fixture(t);
  const invalidState = JSON.stringify({
    'owner/repo#01': {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-08-11T23:59:59.999Z',
    },
  });
  await writeFile(files.stateFile, invalidState);
  let authCalls = 0;
  let searchCalls = 0;
  const dependencies = successfulDependencies([]);
  dependencies.resolveGitHubAuth = async () => {
    authCalls += 1;
    return { ...work, token: 'token' };
  };
  dependencies.searchReviewRequestedPRs = async () => {
    searchCalls += 1;
    return completeSearch([]);
  };

  await assert.rejects(
    pollOnce({
      config: config([work]),
      ...files,
      dependencies,
    }),
    /Invalid review state entry/u,
  );
  assert.equal(authCalls, 0);
  assert.equal(searchCalls, 0);
  assert.equal(await readFile(files.stateFile, 'utf8'), invalidState);
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
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    { repo: 'owner/repo', number: 1 },
    { repo: 'owner/repo', number: 2 },
  ]);
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
    1_000,
  ]);
  assert.deepEqual(events, [
    'reconcile:1@24000',
    'reconcile:2@29000',
    'diff:2@30000',
    'review:2@30000',
    'post:2@33000',
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
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    { repo: 'owner/repo', number: 1 },
    { repo: 'owner/repo', number: 2 },
  ]);
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

test('account schedulers isolate rate-limit backoff without admitting tracked state', async (t) => {
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
    return completeSearch([]);
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
  ]);
  assert.deepEqual(sleeps, [{
    account: 'account-a',
    host: 'github.com',
    milliseconds: 5_000,
  }]);
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
    return completeSearch([]);
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
    return completeSearch([]);
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

test('tracked state does not admit metadata or a new-head review without a fresh request', async (t) => {
  const files = await fixture(t);
  const events = [];
  const account = { ...work, repositories: ['owner/repo'] };
  const initialState = {
    [prKey('owner/repo', 7, account)]: {
      lastReviewedSha: 'sha-A',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);

  const dependencies = successfulDependencies(events);
  dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
  let metadataCalls = 0;
  dependencies.getPullRequest = async () => {
    metadataCalls += 1;
    throw new Error('tracked-only candidates must not reach metadata');
  };
  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.outcomes, []);
  assert.equal(metadataCalls, 0);
  assert.deepEqual(events.filter((event) => event.startsWith('review:')), []);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
});

test('a failed requested-review search retains tracked state without admitting it', async (t) => {
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
  let metadataCalls = 0;
  dependencies.getPullRequest = async () => {
    metadataCalls += 1;
    throw new Error('failed-search state must not reach metadata');
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.failures.map(({ subject, note }) => ({ subject, note })), [
    { subject: 'owner/repo', note: 'search failed' },
  ]);
  assert.deepEqual(result.outcomes, []);
  assert.equal(metadataCalls, 0);
  assert.deepEqual(events.filter((event) => /^(review|post):/.test(event)), []);
  assert.equal(
    JSON.parse(await readFile(files.stateFile, 'utf8'))[
      prKey('owner/repo', 7, account)
    ].lastReviewedSha,
    'sha-A',
  );
});

test('a search without completeness proof cannot admit work or clean state', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const initialState = {
    [prKey('owner/repo', 7, account)]: {
      lastReviewedSha: 'sha-old-7',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    [prKey('owner/repo', 8, account)]: {
      lastReviewedSha: 'sha-old-8',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);

  const dependencies = successfulDependencies([]);
  // Simulate plausible partial rows without a completeness proof.
  dependencies.searchReviewRequestedPRs = async () => [
    { repo: 'owner/repo', number: 7 },
  ];
  let metadataCalls = 0;
  dependencies.getPullRequest = async () => {
    metadataCalls += 1;
    throw new Error('unproven discovery must not reach metadata');
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.outcomes, []);
  assert.deepEqual(result.failures.map(({ subject, note }) => ({ subject, note })), [
    { subject: 'owner/repo', note: 'search completeness unproven' },
  ]);
  assert.equal(metadataCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
});

test('production provenance rejects an exact public descriptor clone without side effects', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const initialState = {
    [prKey('owner/repo', 8, account)]: {
      lastReviewedSha: 'sha-old',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);

  const forged = [{ repo: 'owner/repo', number: 7 }];
  Object.defineProperty(forged, 'complete', {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  const calls = [];
  const dependencies = successfulDependencies([]);
  // Exercise poller's production-default provenance predicate, not the local
  // WeakSet used to brand ordinary unit-test fixtures.
  delete dependencies.isValidatedReviewRequestSearchResult;
  dependencies.searchReviewRequestedPRs = async () => forged;
  dependencies.getPullRequest = async () => {
    calls.push('metadata');
  };
  dependencies.getPullRequestDiff = async () => {
    calls.push('diff');
  };
  dependencies.invokeMultiPassReview = async () => {
    calls.push('reviewer');
  };
  dependencies.postReview = async () => {
    calls.push('post');
  };
  dependencies.saveState = async () => {
    calls.push('state-save');
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.outcomes, []);
  assert.deepEqual(result.failures.map(({ note }) => note), [
    'search completeness unproven',
  ]);
  assert.deepEqual(calls, []);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
});

test('production search output remains an Array and passes production provenance', async (t) => {
  const files = await fixture(t);
  const events = [];
  const account = { ...work, repositories: ['owner/repo'] };
  mockProductionSearchOutput(
    t,
    'meta|1|false\n' +
      'https://api.github.com/repos/owner/repo|7\n',
  );

  let searchResult;
  const mutationErrors = [];
  const metadataCandidates = [];
  const dependencies = successfulDependencies(events);
  delete dependencies.isValidatedReviewRequestSearchResult;
  dependencies.searchReviewRequestedPRs = async (options) => {
    searchResult = await productionSearchReviewRequestedPRs(options);
    for (const mutate of [
      () => { searchResult[0].repo = 'other/repo'; },
      () => { searchResult[0].number = 99; },
      () => { searchResult[0] = { repo: 'other/repo', number: 99 }; },
      () => { searchResult.push({ repo: 'other/repo', number: 99 }); },
    ]) {
      try {
        mutate();
      } catch (err) {
        mutationErrors.push(err);
      }
    }
    return searchResult;
  };
  dependencies.getPullRequest = async ({ repo, number }) => {
    metadataCandidates.push(`${repo}#${number}`);
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

  assert.equal(Array.isArray(searchResult), true);
  assert.equal(searchResult.complete, true);
  assert.equal(Object.isFrozen(searchResult), true);
  assert.equal(Object.isFrozen(searchResult[0]), true);
  assert.equal(mutationErrors.length, 4);
  assert.ok(mutationErrors.every((err) => err instanceof TypeError));
  assert.ok(metadataCandidates.length > 0);
  assert.ok(metadataCandidates.every((candidate) => candidate === 'owner/repo#7'));
  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.deepEqual(result.outcomes.map(({ number, status }) => ({ number, status })), [
    { number: 7, status: 'reviewed' },
  ]);
});

for (const { label, output } of malformedProductionSearchNumberOutputs) {
  test(`production parser rejects ${label} without downstream or state work`, async (t) => {
    const files = await fixture(t);
    const account = { ...work, repositories: ['owner/repo'] };
    const requestedCursorKey = 'github.com@work::owner/repo::requested';
    const initialState = {
      [prKey('owner/repo', 8, account)]: {
        lastReviewedSha: 'sha-old',
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
      [STATE_METADATA_KEY]: {
        version: 1,
        candidateCursors: { [requestedCursorKey]: 4 },
      },
    };
    await saveState(files.stateFile, initialState);
    mockProductionSearchOutput(t, output);

    const calls = [];
    const dependencies = successfulDependencies([]);
    delete dependencies.isValidatedReviewRequestSearchResult;
    dependencies.searchReviewRequestedPRs = productionSearchReviewRequestedPRs;
    dependencies.getPullRequest = async () => {
      calls.push('metadata');
    };
    dependencies.getPullRequestDiff = async () => {
      calls.push('diff');
    };
    dependencies.invokeMultiPassReview = async () => {
      calls.push('reviewer');
    };
    dependencies.postReview = async () => {
      calls.push('post');
    };
    dependencies.saveState = async () => {
      calls.push('state-or-cursor-save');
    };

    const result = await pollOnce({
      config: config([account]),
      ...files,
      dependencies,
    });

    assert.equal(result.failed, true);
    assert.equal(result.reviewed, 0);
    assert.deepEqual(result.outcomes, []);
    assert.deepEqual(result.failures.map(({ note }) => note), ['search failed']);
    assert.deepEqual(calls, []);
    assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
  });
}

for (const { label, installMarker } of [
  {
    label: 'inherited',
    installMarker(candidates, t) {
      const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'complete');
      Object.defineProperty(Array.prototype, 'complete', {
        configurable: true,
        enumerable: false,
        value: true,
        writable: false,
      });
      t.after(() => {
        if (previous) Object.defineProperty(Array.prototype, 'complete', previous);
        else delete Array.prototype.complete;
      });
    },
  },
  {
    label: 'enumerable',
    installMarker(candidates) {
      Object.defineProperty(candidates, 'complete', {
        configurable: false,
        enumerable: true,
        value: true,
        writable: false,
      });
    },
  },
  {
    label: 'writable',
    installMarker(candidates) {
      Object.defineProperty(candidates, 'complete', {
        configurable: false,
        enumerable: false,
        value: true,
        writable: true,
      });
    },
  },
  {
    label: 'configurable',
    installMarker(candidates) {
      Object.defineProperty(candidates, 'complete', {
        configurable: true,
        enumerable: false,
        value: true,
        writable: false,
      });
    },
  },
  {
    label: 'accessor',
    installMarker(candidates) {
      let getterCalls = 0;
      Object.defineProperty(candidates, 'complete', {
        configurable: false,
        enumerable: false,
        get() {
          getterCalls += 1;
          return true;
        },
      });
      return () => assert.equal(getterCalls, 0);
    },
  },
]) {
  test(`${label} completeness markers fail closed without invoking work`, async (t) => {
    const files = await fixture(t);
    const account = { ...work, repositories: ['owner/repo'] };
    const retainedKey = prKey('owner/repo', 8, account);
    const initialState = {
      [retainedKey]: {
        lastReviewedSha: 'sha-old',
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    };
    await saveState(files.stateFile, initialState);

    const candidates = [{ repo: 'owner/repo', number: 7 }];
    const assertMarker = installMarker(candidates, t);
    const calls = [];
    const dependencies = successfulDependencies([]);
    dependencies.searchReviewRequestedPRs = async () => candidates;
    dependencies.getPullRequest = async () => {
      calls.push('metadata');
    };
    dependencies.getPullRequestDiff = async () => {
      calls.push('diff');
    };
    dependencies.invokeMultiPassReview = async () => {
      calls.push('reviewer');
    };
    dependencies.postReview = async () => {
      calls.push('post');
    };

    const result = await pollOnce({
      config: config([account]),
      ...files,
      dependencies,
    });

    if (assertMarker) assertMarker();
    assert.equal(result.failed, true);
    assert.equal(result.reviewed, 0);
    assert.deepEqual(result.outcomes, []);
    assert.deepEqual(result.failures.map(({ note }) => note), [
      'search completeness unproven',
    ]);
    assert.deepEqual(calls, []);
    assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
  });
}

for (const [label, diagnostic] of [
  ['changing total_count', 'inconsistent pagination metadata'],
  ['missing pagination metadata', 'incomplete pagination metadata'],
  ['duplicate candidates', 'duplicate pull request candidate'],
  ['mismatched candidate count', 'candidate count did not match result metadata'],
]) {
  test(`untrustworthy ${label} discovery retains state without review`, async (t) => {
    const files = await fixture(t);
    const account = { ...work, repositories: ['owner/repo'] };
    const initialState = {
      [prKey('owner/repo', 7, account)]: {
        lastReviewedSha: 'sha-old-7',
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
      [prKey('owner/repo', 8, account)]: {
        lastReviewedSha: 'sha-old-8',
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    };
    await saveState(files.stateFile, initialState);

    const dependencies = successfulDependencies([]);
    dependencies.searchReviewRequestedPRs = async () => {
      throw new Error(`GitHub search returned ${diagnostic}`);
    };
    let metadataCalls = 0;
    dependencies.getPullRequest = async () => {
      metadataCalls += 1;
      throw new Error('untrustworthy discovery must not reach metadata');
    };

    const result = await pollOnce({
      config: config([account]),
      ...files,
      dependencies,
    });

    assert.equal(result.failed, true);
    assert.equal(result.reviewed, 0);
    assert.deepEqual(result.outcomes, []);
    assert.deepEqual(result.failures.map(({ subject, note }) => ({ subject, note })), [
      { subject: 'owner/repo', note: 'search failed' },
    ]);
    assert.equal(metadataCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
  });
}

test('a search failure preserves all state scopes without metadata reads', async (t) => {
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
  assert.deepEqual(metadataCandidates, []);
  assert.deepEqual(result.outcomes, []);
  assert.deepEqual(
    JSON.parse(await readFile(files.stateFile, 'utf8')),
    {
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
    },
  );
});

test('a foreign requested repository is rejected before metadata, review, or post', async (t) => {
  const files = await fixture(t);
  const calls = [];
  const account = { ...work, repositories: ['owner/repo'] };
  const retainedKey = prKey('owner/repo', 8, account);
  await saveState(files.stateFile, {
    [retainedKey]: {
      lastReviewedSha: 'sha-old',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    { repo: 'other/secret', number: 7 },
  ]);
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
  assert.equal(
    JSON.parse(await readFile(files.stateFile, 'utf8'))[retainedKey].lastReviewedSha,
    'sha-old',
  );
});

test('one foreign row rejects the whole requested-review scope', async (t) => {
  const files = await fixture(t);
  const metadataRepos = [];
  const account = { ...work, repositories: ['owner/repo'] };
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    { repo: 'other/secret', number: 7 },
    ...Array.from({ length: MAX_REVIEWS_PER_POLL }, (_, index) => ({
      repo: 'owner/repo',
      number: index + 1,
    })),
  ]);
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

  assert.equal(result.reviewed, 0);
  assert.equal(result.failed, true);
  assert.deepEqual(result.failures.map(({ note }) => note), ['search candidate rejected']);
  assert.deepEqual(metadataRepos, []);
});

test('one malformed row rejects the whole requested-review scope', async (t) => {
  const files = await fixture(t);
  const calls = [];
  const account = { ...work, repositories: ['owner/repo'] };
  const retainedKey = prKey('owner/repo', 8, account);
  await saveState(files.stateFile, {
    [retainedKey]: {
      lastReviewedSha: 'sha-old',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    null,
    { repo: 'owner/repo', number: 0 },
    { repo: 'owner/repo', number: 7 },
  ]);
  dependencies.getPullRequest = async ({ number }) => {
    calls.push(`metadata:${number}`);
    return {
      headRefOid: 'sha-1',
      number,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: 'OPEN',
    };
  };
  dependencies.getPullRequestDiff = async () => {
    calls.push('diff');
    return '@@ -0,0 +1 @@\n+line\n';
  };
  dependencies.invokeMultiPassReview = async () => {
    calls.push('reviewer');
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

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.failures.map(({ note }) => note), [
    'search candidate rejected',
    'search candidate rejected',
  ]);
  assert.deepEqual(calls, []);
  assert.equal(
    JSON.parse(await readFile(files.stateFile, 'utf8'))[retainedKey].lastReviewedSha,
    'sha-old',
  );
});

test('search absence retains tracked state during a dry run', async (t) => {
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
  dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
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
    dryRun: true,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.outcomes, []);
  assert.deepEqual(events.filter((event) => event.startsWith('review:')), []);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  assert.equal(
    JSON.parse(await readFile(files.stateFile, 'utf8'))[
      prKey('owner/repo', 7, account)
    ].lastReviewedSha,
    'sha-B',
  );
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
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    { repo: 'owner/repo', number: 7 },
  ]);
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

test('mixed-case scoped state is retained without metadata when requested search is empty', async (t) => {
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
  dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
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
  assert.equal(result.reviewed, 0);
  assert.deepEqual(result.outcomes, []);
  assert.deepEqual(events.filter((event) => event.startsWith('review:')), []);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), {
    'GITHUB.COM@WORK::OWNER/REPO#7': {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });
});

test('a requested PR that closes after search is retired without review', async (t) => {
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
  dependencies.searchReviewRequestedPRs = async () => completeSearch([{
    repo: 'owner/repo',
    number: 7,
  }]);
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

test('initial closure cleanup rolls back when state persistence fails', async (t) => {
  const files = await fixture(t);
  const key = prKey('owner/repo', 7, work);
  const initialState = {
    [key]: {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);
  const dependencies = successfulDependencies([]);
  dependencies.getPullRequest = async () => ({
    headRefOid: 'new-sha',
    number: 7,
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    body: '',
    state: 'CLOSED',
  });
  dependencies.saveState = async () => { throw new Error('disk full'); };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.equal(result.failures[0].note, 'tracking cleanup failed');
  assert.deepEqual(
    JSON.parse(await readFile(files.stateFile, 'utf8')),
    initialState,
  );
});

test('search absence retains historical state in every account and repository scope', async (t) => {
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
  dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
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
  assert.deepEqual(metadataNumbers, []);
  assert.deepEqual(events.filter((event) => event.startsWith('review:')), []);
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(files.stateFile, 'utf8'))).sort(),
    [
      prKey('owner/repo', 7, account),
      prKey('owner/repo', 8, personal),
      prKey('other/repo', 9, account),
      prKey('owner/repo', 10, enterprise),
    ].sort(),
  );
});

test('historical tracked backlog is retained without consuming requested candidate metadata', async (t) => {
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
  dependencies.searchReviewRequestedPRs = async ({ repo }) => completeSearch(
    repo === 'owner/new' ? [{ repo, number: 99 }] : [],
  );
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
  assert.deepEqual(metadataCandidates, [
    'owner/new#99',
    'owner/new#99',
    'owner/new#99',
  ]);
  assert.deepEqual(
    result.outcomes.map(({ repo, number, status }) => ({ repo, number, status })),
    [{ repo: 'owner/new', number: 99, status: 'reviewed' }],
  );
  const persisted = JSON.parse(await readFile(files.stateFile, 'utf8'));
  for (const key of Object.keys(trackedState)) {
    assert.deepEqual(persisted[key], trackedState[key]);
  }
});

test('a changed candidate in another repository receives safety-cap capacity', async (t) => {
  const files = await fixture(t);
  const account = {
    ...work,
    repositories: ['owner/busy', 'owner/starved'],
  };
  const reviewedCandidates = [];
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async ({ repo }) => completeSearch(
    repo === 'owner/busy'
      ? Array.from({ length: MAX_REVIEWS_PER_POLL }, (_, index) => ({
        repo,
        number: index + 1,
      }))
      : [{ repo, number: 99 }],
  );
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
    completeSearch(Array.from({ length: MAX_REVIEWS_PER_POLL + 1 }, (_, index) => ({
      repo,
      number: index + 1,
    })));
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
    completeSearch(Array.from({ length: MAX_CANDIDATE_METADATA_PER_POLL + 1 }, (_, index) => ({
      repo,
      number: index + 1,
    })));
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
    completeSearch(Array.from({ length: MAX_CANDIDATE_METADATA_PER_POLL + 1 }, (_, index) => ({
      repo,
      number: index + 1,
    })));
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
    completeSearch(Array.from({ length: MAX_REVIEWS_PER_POLL + 1 }, (_, index) => ({
      repo,
      number: index + 1,
    })));
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

test('tracked-only backlog consumes no metadata budget or deferral capacity', async (t) => {
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
  dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
  dependencies.getPullRequest = async ({ number }) => {
    metadataCandidates.push(number);
    throw new Error('tracked-only backlog must not reach metadata');
  };

  const firstPoll = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(firstPoll.failed, false);
  assert.equal(firstPoll.reviewed, 0);
  assert.deepEqual(firstPoll.outcomes, []);
  assert.deepEqual(firstPoll.failures, []);
  assert.deepEqual(metadataCandidates, []);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), trackedState);
});

test('same-count membership churn never deletes historical state or reviews unsafe rows', async (t) => {
  const files = await fixture(t);
  const account = { ...work, repositories: ['owner/repo'] };
  const trackedCursorKey = 'github.com@work::owner/repo::tracked';
  const requestedCursorKey = 'github.com@work::owner/repo::requested';
  const initialState = {
    [STATE_METADATA_KEY]: {
      version: 1,
      candidateCursors: {
        [trackedCursorKey]: 1,
        [requestedCursorKey]: 100,
      },
    },
  };
  for (let number = 1; number <= 102; number += 1) {
    initialState[prKey('owner/repo', number, account)] = {
      lastReviewedSha: 'sha-current',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    };
  }
  await saveState(files.stateFile, initialState);

  const dependencies = successfulDependencies([]);
  // Model page one returning 1..100 and page two returning 102 while both
  // pages report total_count 101. PR 101 is absent despite the stable count.
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    ...Array.from({ length: 100 }, (_, index) => ({
      repo: 'owner/repo',
      number: index + 1,
    })),
    { repo: 'owner/repo', number: 102 },
  ]);
  const metadataNumbers = [];
  dependencies.getPullRequest = async ({ number }) => {
    metadataNumbers.push(number);
    return {
      headRefOid: 'sha-current',
      number,
      title: `PR ${number}`,
      url: `https://github.com/owner/repo/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };
  let reviewerCalls = 0;
  let postCalls = 0;
  dependencies.invokeMultiPassReview = async () => {
    reviewerCalls += 1;
    return { summary: 'must not review', findings: [] };
  };
  dependencies.postReview = async () => {
    postCalls += 1;
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  assert.equal(reviewerCalls, 0);
  assert.equal(postCalls, 0);
  assert.equal(metadataNumbers.includes(101), false);
  assert.equal(metadataNumbers[0], 102);
  const persisted = JSON.parse(await readFile(files.stateFile, 'utf8'));
  for (let number = 1; number <= 102; number += 1) {
    assert.deepEqual(
      persisted[prKey('owner/repo', number, account)],
      initialState[prKey('owner/repo', number, account)],
    );
  }
  assert.equal(
    persisted[STATE_METADATA_KEY].candidateCursors[trackedCursorKey],
    1,
  );
});

test('empty requested search performs no state write and preserves mixed-case history', async (t) => {
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
  dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
  let metadataCalls = 0;
  dependencies.getPullRequest = async () => {
    metadataCalls += 1;
    throw new Error('tracked-only state must not reach metadata');
  };
  let saveCalls = 0;
  dependencies.saveState = async () => {
    saveCalls += 1;
    throw new Error('an empty search must not save state');
  };

  const result = await pollOnce({
    config: config([account]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.deepEqual(result.failures, []);
  assert.equal(metadataCalls, 0);
  assert.equal(saveCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
});

test('a requested PR already present in state is admitted only once', async (t) => {
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
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    { repo: 'owner/repo', number: 7 },
  ]);
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

test('requested repository aliases are de-duplicated while API spelling is preserved', async (t) => {
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
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    { repo: 'Owner/repo', number: 7 },
  ]);
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
  const retainedKey = prKey('owner/repo', 8, work);
  await saveState(files.stateFile, {
    [retainedKey]: {
      lastReviewedSha: 'sha-old',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  });
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
  assert.equal(
    JSON.parse(await readFile(files.stateFile, 'utf8'))[retainedKey].lastReviewedSha,
    'sha-old',
  );
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
    dependencies.searchReviewRequestedPRs = async () => completeSearch([
      { repo: 'owner/repo', number: 1 },
      { repo: 'owner/repo', number: 2 },
    ]);
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

test('a PR closed at the mutation boundary retires its exact tracked state', async (t) => {
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
  assert.equal(saveCalls, 1);
  assert.deepEqual(
    JSON.parse(await readFile(files.stateFile, 'utf8')),
    {},
  );
});

test('mutation-boundary closure cleanup rolls back when state persistence fails', async (t) => {
  const files = await fixture(t);
  const key = prKey('owner/repo', 7, work);
  const initialState = {
    [key]: {
      lastReviewedSha: 'prior-sha',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);

  const dependencies = successfulDependencies([]);
  let metadataCalls = 0;
  dependencies.getPullRequest = async () => ({
    headRefOid: 'sha-1',
    number: 7,
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    body: '',
    state: ++metadataCalls === 3 ? 'MERGED' : 'OPEN',
  });
  dependencies.saveState = async () => { throw new Error('disk full'); };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.equal(result.failures[0].note, 'tracking cleanup failed');
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
  assert.equal(events.filter((event) => event === 'github:scheduled').length, 7);
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
    assert.equal(events.filter((event) => event === 'github:scheduled').length, 7);
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

test('nullable unrelated history rows do not block poll rehydration', async (t) => {
  const files = await fixture(t);
  const events = [];
  let diffCalls = 0;
  let postCalls = 0;
  const dependencies = successfulDependencies(events);
  dependencies.reviewAlreadyPosted = (options) => productionReviewAlreadyPosted({
    ...options,
    request: async () => [
      JSON.stringify({
        body: null,
        commit_id: null,
        state: 'PENDING',
        user_login: null,
      }),
      JSON.stringify({
        body: `recovered\n${options.marker}`,
        commit_id: options.commitId,
        state: 'COMMENTED',
        user_login: options.auth.username,
      }),
      JSON.stringify({
        body: null,
        commit_id: null,
        state: 'DISMISSED',
        user_login: null,
      }),
    ].join('\n'),
  });
  dependencies.getPullRequestDiff = async () => {
    diffCalls += 1;
    return '';
  };
  dependencies.postReview = async () => {
    postCalls += 1;
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(result.outcomes[0].status, 'recovered');
  assert.equal(diffCalls, 0);
  assert.equal(postCalls, 0);
  assert.deepEqual(events.filter((event) => event.startsWith('review:')), []);
  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.equal(
    state[prKey('owner/repo', 7, work)].lastReviewedSha,
    'sha-1',
  );
});

test('a review request revoked after generation skips posting without failing or recording', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  let requestChecks = 0;
  dependencies.hasActiveReviewRequest = async () => {
    requestChecks += 1;
    return false;
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
  assert.equal(requestChecks, 1);
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
});

test('a review request revoked during cadence wait is rejected at the POST boundary', async (t) => {
  const files = await fixture(t);
  const events = [];
  const dependencies = successfulDependencies(events);
  let cadenceStarted = false;
  let requestChecks = 0;
  dependencies.createGitHubMutationCadence = () => ({
    run: async (operation, { beforeStart }) => {
      cadenceStarted = true;
      await beforeStart();
      return operation();
    },
  });
  dependencies.hasActiveReviewRequest = async () => {
    requestChecks += 1;
    return !cadenceStarted;
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(cadenceStarted, true);
  assert.equal(requestChecks, 2);
  assert.deepEqual(result, {
    failed: false,
    reviewed: 0,
    outcomes: [],
    failures: [],
  });
  assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
});

test('a revoked request blocks the 422 fallback POST after reconciliation', async (t) => {
  const files = await fixture(t);
  const events = [];
  const requestMethods = [];
  const dependencies = successfulDependencies(events);
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
  let requestChecks = 0;
  dependencies.hasActiveReviewRequest = async () => {
    requestChecks += 1;
    return requestChecks < 3;
  };
  dependencies.postReview = async (options) => productionPostReview({
    ...options,
    request: async (args) => {
      const method = args[args.indexOf('--method') + 1];
      requestMethods.push(method);
      if (method === 'GET') return '';
      throw Object.assign(new Error('HTTP 422: Validation Failed'), { status: 422 });
    },
  });

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(requestChecks, 3);
  assert.deepEqual(requestMethods, ['POST', 'GET']);
  assert.deepEqual(result, {
    failed: false,
    reviewed: 0,
    outcomes: [],
    failures: [],
  });
  await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
});

test('successful-post reconciliation remains allowed after GitHub clears the request', async (t) => {
  const files = await fixture(t);
  const events = [];
  const requestMethods = [];
  const dependencies = successfulDependencies(events);
  let requestActive = true;
  let requestChecks = 0;
  dependencies.hasActiveReviewRequest = async () => {
    requestChecks += 1;
    return requestActive;
  };
  dependencies.postReview = async (options) => {
    let submitted;
    return productionPostReview({
      ...options,
      request: async (args, requestOptions) => {
        const method = args[args.indexOf('--method') + 1];
        requestMethods.push(method);
        if (method === 'POST') {
          submitted = JSON.parse(requestOptions.input);
          requestActive = false;
          throw new Error('connection reset after accepted response');
        }
        return JSON.stringify({
          body: submitted.body,
          commit_id: options.commitId,
          state: 'COMMENTED',
          user_login: options.auth.username,
        });
      },
    });
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 1);
  assert.equal(result.outcomes[0].status, 'reviewed');
  assert.equal(requestChecks, 2);
  assert.deepEqual(requestMethods, ['POST', 'GET']);
  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.equal(state[prKey('owner/repo', 7, work)].lastReviewedSha, 'sha-1');
});

for (const boundary of ['post-generation', 'mutation']) {
  test(`${boundary} review-request lookup failures fail closed without posting`, async (t) => {
    const files = await fixture(t);
    const events = [];
    const dependencies = successfulDependencies(events);
    let requestChecks = 0;
    dependencies.hasActiveReviewRequest = async () => {
      requestChecks += 1;
      if (boundary === 'post-generation' || requestChecks === 2) {
        throw new Error('requested-reviewer lookup failed');
      }
      return true;
    };

    const result = await pollOnce({
      config: config([work]),
      ...files,
      dependencies,
    });

    assert.equal(result.failed, true);
    assert.equal(result.reviewed, 0);
    assert.equal(
      result.failures[0].note,
      boundary === 'post-generation'
        ? 'review request verification failed'
        : 'review post failed',
    );
    assert.deepEqual(events.filter((event) => event.startsWith('post:')), []);
    await assert.rejects(readFile(files.stateFile, 'utf8'), { code: 'ENOENT' });
  });
}

test('closure after generation retires only the exact reviewer state key', async (t) => {
  const files = await fixture(t);
  const workKey = prKey('owner/repo', 7, work);
  const personalKey = prKey('owner/repo', 7, personal);
  const initialState = {
    [workKey]: {
      lastReviewedSha: 'work-old',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    },
    [personalKey]: {
      lastReviewedSha: 'personal-old',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);
  const dependencies = successfulDependencies([]);
  let metadataCalls = 0;
  dependencies.getPullRequest = async () => ({
    headRefOid: 'sha-1',
    number: 7,
    title: 'PR',
    url: 'https://github.com/owner/repo/pull/7',
    body: '',
    state: ++metadataCalls === 2 ? 'CLOSED' : 'OPEN',
  });

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewed, 0);
  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.equal(state[workKey], undefined);
  assert.deepEqual(state[personalKey], initialState[personalKey]);
});

for (const dryRun of [false, true]) {
  test(`post-generation closure ${dryRun ? 'is retained in dry run' : 'rolls back on cleanup save failure'}`, async (t) => {
    const files = await fixture(t);
    const key = prKey('owner/repo', 7, work);
    const initialState = {
      [key]: {
        lastReviewedSha: 'old-sha',
        lastReviewedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    await saveState(files.stateFile, initialState);
    const dependencies = successfulDependencies([]);
    let metadataCalls = 0;
    dependencies.getPullRequest = async () => ({
      headRefOid: 'sha-1',
      number: 7,
      title: 'PR',
      url: 'https://github.com/owner/repo/pull/7',
      body: '',
      state: ++metadataCalls === 2 ? 'MERGED' : 'OPEN',
    });
    if (!dryRun) {
      dependencies.saveState = async () => { throw new Error('disk full'); };
    }

    const result = await pollOnce({
      config: config([work]),
      ...files,
      dryRun,
      dependencies,
    });

    assert.equal(result.failed, !dryRun);
    if (!dryRun) assert.equal(result.failures[0].note, 'tracking cleanup failed');
    assert.deepEqual(
      JSON.parse(await readFile(files.stateFile, 'utf8')),
      initialState,
    );
  });
}

test('historical-state GC checks at most 25 keys and advances fairly from its cursor', async (t) => {
  const files = await fixture(t);
  const initialState = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [
      prKey('owner/repo', index + 1, work),
      {
        lastReviewedSha: `sha-${index + 1}`,
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    ]),
  );
  await saveState(files.stateFile, initialState);
  const expectedKeys = Object.keys(initialState).sort();

  async function runSweep(checked) {
    const dependencies = successfulDependencies([]);
    dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
    dependencies.getPullRequestForStateGc = async ({ repo, number }) => {
      checked.push(prKey(repo, number, work));
      return {
        headRefOid: `sha-${number}`,
        number,
        title: 'Tracked PR',
        url: `https://github.com/${repo}/pull/${number}`,
        body: '',
        state: 'OPEN',
      };
    };
    return pollOnce({
      config: config([work]),
      ...files,
      dependencies,
    });
  }

  const firstChecked = [];
  const first = await runSweep(firstChecked);
  assert.equal(first.failed, false);
  assert.deepEqual(
    firstChecked,
    expectedKeys.slice(0, MAX_STATE_GC_CHECKS_PER_POLL),
  );
  let state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.equal(
    state[STATE_METADATA_KEY].reviewStateGcAfterKey,
    expectedKeys[MAX_STATE_GC_CHECKS_PER_POLL - 1],
  );

  const secondChecked = [];
  const second = await runSweep(secondChecked);
  assert.equal(second.failed, false);
  assert.equal(secondChecked.length, MAX_STATE_GC_CHECKS_PER_POLL);
  assert.deepEqual(secondChecked.slice(0, 5), expectedKeys.slice(25));
  assert.deepEqual(secondChecked.slice(5), expectedKeys.slice(0, 20));
});

test('historical-state GC deletes only confirmed closed states and retains failures', async (t) => {
  const files = await fixture(t);
  const initialState = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [
      prKey('owner/repo', index + 1, work),
      {
        lastReviewedSha: `sha-${index + 1}`,
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
      },
    ]),
  );
  await saveState(files.stateFile, initialState);
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => {
    if (number === 4) {
      throw Object.assign(new Error('HTTP 404: Not Found'), { status: 404 });
    }
    if (number === 5) return { state: 'CLOSED' };
    return {
      headRefOid: `sha-${number}`,
      number,
      title: 'Tracked PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: number === 1 ? 'CLOSED' : number === 2 ? 'MERGED' : 'OPEN',
    };
  };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.equal(state[prKey('owner/repo', 1, work)], undefined);
  assert.equal(state[prKey('owner/repo', 2, work)], undefined);
  for (const number of [3, 4, 5]) {
    assert.deepEqual(
      state[prKey('owner/repo', number, work)],
      initialState[prKey('owner/repo', number, work)],
    );
  }
});

test('historical-state GC is isolated to selected authenticated account repositories', async (t) => {
  const files = await fixture(t);
  const enterprise = {
    hostname: 'enterprise.example.com',
    username: 'work',
    repositories: ['owner/repo'],
  };
  const initialState = {
    [prKey('owner/repo', 1, work)]: {
      lastReviewedSha: 'selected',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    [prKey('owner/repo', 2, personal)]: {
      lastReviewedSha: 'sibling-account',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    [prKey('other/repo', 3, work)]: {
      lastReviewedSha: 'unconfigured-repo',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    [prKey('owner/repo', 4, enterprise)]: {
      lastReviewedSha: 'unselected-host',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    'owner/repo#5': {
      lastReviewedSha: 'unscoped',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);
  const checked = [];
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => {
    checked.push(`${repo}#${number}`);
    return {
      headRefOid: 'sha',
      number,
      title: 'Tracked PR',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    };
  };

  const result = await pollOnce({
    config: config([work, personal]),
    accountSelector: { hostname: 'github.com', username: 'work' },
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.deepEqual(checked, ['owner/repo#1']);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
});

test('historical-state GC rolls back its whole deletion batch when persistence fails', async (t) => {
  const files = await fixture(t);
  const initialState = {
    [prKey('owner/repo', 1, work)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
    [prKey('owner/repo', 2, work)]: {
      lastReviewedSha: 'sha-2',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => ({
    headRefOid: `sha-${number}`,
    number,
    title: 'Tracked PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'CLOSED',
  });
  dependencies.saveState = async () => { throw new Error('disk full'); };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'state GC persistence failed');
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
});

test('dry runs never execute or persist historical-state GC', async (t) => {
  const files = await fixture(t);
  const initialState = {
    [prKey('owner/repo', 1, work)]: {
      lastReviewedSha: 'sha-1',
      lastReviewedAt: '2026-08-05T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);
  const dependencies = successfulDependencies([]);
  dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
  let gcChecks = 0;
  let saveCalls = 0;
  dependencies.getPullRequestForStateGc = async () => { gcChecks += 1; };
  dependencies.saveState = async () => { saveCalls += 1; };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dryRun: true,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(gcChecks, 0);
  assert.equal(saveCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), initialState);
});

test('retention expires deconfigured and unscoped state without remotely sweeping them', async (t) => {
  const files = await fixture(t);
  const now = Date.parse('2026-08-11T00:00:00.000Z');
  const deconfiguredKey = prKey('owner/repo', 1, personal);
  const unscopedKey = 'owner/repo#2';
  const selectedKey = prKey('owner/repo', 3, work);
  await saveState(files.stateFile, {
    [deconfiguredKey]: {
      lastReviewedSha: 'old-personal',
      lastReviewedAt: '2025-08-11T00:00:00.000Z',
    },
    [unscopedKey]: {
      lastReviewedSha: 'old-unscoped',
      lastReviewedAt: '2025-08-11T00:00:00.000Z',
    },
    [selectedKey]: {
      lastReviewedSha: 'current',
      lastReviewedAt: '2025-08-11T00:00:00.001Z',
    },
  });
  const checked = [];
  const dependencies = successfulDependencies([]);
  dependencies.now = () => now;
  dependencies.searchReviewRequestedPRs = async () => completeSearch([]);
  dependencies.getPullRequestForStateGc = async ({ repo, number }) => {
    checked.push(`${repo}#${number}`);
    return {
      headRefOid: 'current',
      number,
      title: 'Tracked PR',
      url: `https://github.com/${repo}/pull/${number}`,
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
  assert.deepEqual(checked, ['owner/repo#3']);
  const state = JSON.parse(await readFile(files.stateFile, 'utf8'));
  assert.equal(state[deconfiguredKey], undefined);
  assert.equal(state[unscopedKey], undefined);
  assert.ok(state[selectedKey]);
});

test('retention expiry rolls back and stops before external work when saving fails', async (t) => {
  const files = await fixture(t);
  const key = prKey('owner/repo', 1, work);
  const initialState = {
    [key]: {
      lastReviewedSha: 'old-sha',
      lastReviewedAt: '2025-08-11T00:00:00.000Z',
    },
  };
  await saveState(files.stateFile, initialState);
  let authCalls = 0;
  const dependencies = successfulDependencies([]);
  dependencies.now = () => Date.parse('2026-08-11T00:00:00.000Z');
  dependencies.resolveGitHubAuth = async () => {
    authCalls += 1;
    return { ...work, token: 'token' };
  };
  dependencies.saveState = async () => { throw new Error('disk full'); };

  const result = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.reviewed, 0);
  assert.equal(result.failures[0].note, 'retention cleanup failed');
  assert.equal(authCalls, 0);
  assert.deepEqual(
    JSON.parse(await readFile(files.stateFile, 'utf8')),
    initialState,
  );
});

function capacityState(
  entryCount,
  {
    account = work,
    repo = 'owner/repo',
    marker = false,
    shaFor = (number) => `old-${number}`,
  } = {},
) {
  return Object.fromEntries(
    Array.from({ length: entryCount }, (_, index) => [
      prKey(repo, index + 1, account),
      {
        lastReviewedSha: shaFor(index + 1),
        lastReviewedAt: '2026-08-05T00:00:00.000Z',
        ...(marker ? { reviewMarkerVersion: 1 } : {}),
      },
    ]),
  );
}

function padStateNearByteLimit(state, targetBytes = MAX_STATE_FILE_BYTES - 1) {
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

test('state capacity fails before posting a new key but permits an existing-key update', async (t) => {
  const files = await fixture(t);
  const fullState = capacityState(MAX_REVIEW_STATE_ENTRIES);
  let lastSaved;
  const dependencies = successfulDependencies([]);
  dependencies.loadState = async () => fullState;
  dependencies.saveState = async (_path, state) => {
    lastSaved = structuredClone(state);
  };
  dependencies.searchReviewRequestedPRs = async () => completeSearch([{
    repo: 'owner/repo',
    number: MAX_REVIEW_STATE_ENTRIES + 1,
  }]);
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'new-sha',
    number,
    title: 'PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  let postCalls = 0;
  dependencies.postReview = async ({ scheduleMutation }) =>
    scheduleMutation(async () => { postCalls += 1; });

  const blocked = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });
  assert.equal(blocked.failed, true);
  assert.equal(blocked.failures.at(-1).note, 'review state capacity reached');
  assert.equal(postCalls, 0);
  assert.equal(
    lastSaved?.[prKey('owner/repo', MAX_REVIEW_STATE_ENTRIES + 1, work)],
    undefined,
  );

  dependencies.searchReviewRequestedPRs = async () => completeSearch([{
    repo: 'owner/repo',
    number: 1,
  }]);
  const updated = await pollOnce({
    config: config([work]),
    ...files,
    dependencies,
  });
  assert.equal(updated.failed, false);
  assert.equal(updated.outcomes[0].status, 're-reviewed');
  assert.equal(postCalls, 1);
  assert.equal(lastSaved[prKey('owner/repo', 1, work)].lastReviewedSha, 'new-sha');
});

test('concurrent new-key reservations enforce the state capacity before either POST', async (t) => {
  const files = await fixture(t);
  const almostFullState = capacityState(MAX_REVIEW_STATE_ENTRIES - 1);
  let lastSaved;
  const posted = [];
  const dependencies = successfulDependencies([]);
  dependencies.loadState = async () => almostFullState;
  dependencies.saveState = async (_path, state) => {
    lastSaved = structuredClone(state);
  };
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    { repo: 'owner/repo', number: MAX_REVIEW_STATE_ENTRIES },
    { repo: 'owner/repo', number: MAX_REVIEW_STATE_ENTRIES + 1 },
  ]);
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: `new-${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  dependencies.postReview = async ({ number, scheduleMutation }) =>
    scheduleMutation(async () => { posted.push(number); });

  const result = await pollOnce({
    config: { ...config([work]), reviewBatchSize: 2 },
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(posted.length, 1);
  assert.equal(result.failures.at(-1).note, 'review state capacity reached');
  assert.equal(
    Object.keys(lastSaved).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
});

test('a failed post releases its new-key reservation for a later candidate', async (t) => {
  const files = await fixture(t);
  const almostFullState = capacityState(MAX_REVIEW_STATE_ENTRIES - 1);
  let lastSaved;
  const posted = [];
  const dependencies = successfulDependencies([]);
  dependencies.loadState = async () => almostFullState;
  dependencies.saveState = async (_path, state) => {
    lastSaved = structuredClone(state);
  };
  dependencies.searchReviewRequestedPRs = async () => completeSearch([
    { repo: 'owner/repo', number: MAX_REVIEW_STATE_ENTRIES },
    { repo: 'owner/repo', number: MAX_REVIEW_STATE_ENTRIES + 1 },
  ]);
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: `new-${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  dependencies.postReview = async ({ number, scheduleMutation }) =>
    scheduleMutation(async () => {
      posted.push(number);
      if (number === MAX_REVIEW_STATE_ENTRIES) throw new Error('POST failed');
    });

  const result = await pollOnce({
    config: { ...config([work]), reviewBatchSize: 1 },
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.deepEqual(posted, [
    MAX_REVIEW_STATE_ENTRIES,
    MAX_REVIEW_STATE_ENTRIES + 1,
  ]);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].number, MAX_REVIEW_STATE_ENTRIES + 1);
  assert.equal(result.failures[0].note, 'review post failed');
  assert.equal(
    Object.keys(lastSaved).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
});

test('entry-pressure admission borrows unused capacity from a proven donor', async (t) => {
  const files = await fixture(t);
  const donor = { ...work, repositories: ['owner/repo'] };
  const target = { ...personal, repositories: ['other/repo'] };
  const fullState = capacityState(MAX_REVIEW_STATE_ENTRIES, {
    account: donor,
    marker: true,
  });
  let lastSaved;
  let diffCalls = 0;
  const dependencies = successfulDependencies([]);
  dependencies.loadState = async () => fullState;
  dependencies.saveState = async (_path, nextState) => {
    lastSaved = structuredClone(nextState);
  };
  dependencies.searchReviewRequestedPRs = async ({ repo }) => completeSearch(
    repo === 'other/repo' ? [{ repo, number: 1 }] : [],
  );
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'target-sha',
    number,
    title: 'Target PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  dependencies.getPullRequestDiff = async () => {
    diffCalls += 1;
    return '@@ -0,0 +1 @@\n+line\n';
  };

  const result = await pollOnce({
    config: config([donor, target]),
    accountSelector: { hostname: target.hostname, username: target.username },
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.outcomes[0].status, 'reviewed');
  assert.equal(diffCalls, 1);
  assert.equal(lastSaved[prKey('owner/repo', 1, donor)], undefined);
  assert.ok(lastSaved[prKey('owner/repo', 2, donor)]);
  assert.equal(lastSaved[prKey('other/repo', 1, target)].reviewMarkerVersion, 1);
  assert.equal(
    Object.keys(lastSaved).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
});

test('deconfigured proven scopes have zero protected capacity share', async (t) => {
  const files = await fixture(t);
  const deconfigured = { ...work, repositories: ['owner/repo'] };
  const target = { ...personal, repositories: ['other/repo'] };
  const fullState = capacityState(MAX_REVIEW_STATE_ENTRIES, {
    account: deconfigured,
    marker: true,
  });
  let lastSaved;
  const dependencies = successfulDependencies([]);
  dependencies.loadState = async () => fullState;
  dependencies.saveState = async (_path, nextState) => {
    lastSaved = structuredClone(nextState);
  };
  dependencies.searchReviewRequestedPRs = async ({ repo }) =>
    completeSearch([{ repo, number: 1 }]);
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'target-sha',
    number,
    title: 'Target PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });

  const result = await pollOnce({
    config: config([target]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(lastSaved[prKey('owner/repo', 1, deconfigured)], undefined);
  assert.ok(lastSaved[prKey('other/repo', 1, target)]);
});

test('entry-pressure reclaim preserves another configured scope floor', async (t) => {
  const files = await fixture(t);
  const first = { ...work, repositories: ['owner/first'] };
  const second = { ...personal, repositories: ['owner/second'] };
  const state = {
    ...capacityState(MAX_REVIEW_STATE_ENTRIES / 2, {
      account: first,
      repo: 'owner/first',
      marker: true,
    }),
    ...capacityState(MAX_REVIEW_STATE_ENTRIES / 2, {
      account: second,
      repo: 'owner/second',
      marker: true,
    }),
  };
  let lastSaved;
  const dependencies = successfulDependencies([]);
  dependencies.loadState = async () => state;
  dependencies.saveState = async (_path, nextState) => {
    lastSaved = structuredClone(nextState);
  };
  dependencies.searchReviewRequestedPRs = async ({ repo }) => completeSearch([{
    repo,
    number: MAX_REVIEW_STATE_ENTRIES / 2 + 1,
  }]);
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'next-sha',
    number,
    title: 'Next PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });

  const result = await pollOnce({
    config: config([first, second]),
    accountSelector: { hostname: first.hostname, username: first.username },
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(lastSaved[prKey('owner/first', 1, first)], undefined);
  assert.ok(lastSaved[prKey('owner/second', 1, second)]);
  assert.ok(lastSaved[prKey(
    'owner/first',
    MAX_REVIEW_STATE_ENTRIES / 2 + 1,
    first,
  )]);
});

test('simultaneous pressure never crosses either configured scope floor', async (t) => {
  const files = await fixture(t);
  const donor = { ...work, repositories: ['owner/repo'] };
  const target = { ...personal, repositories: ['other/repo'] };
  const state = capacityState(MAX_REVIEW_STATE_ENTRIES, {
    account: donor,
    marker: true,
    shaFor: () => 's',
  });
  const byteFloor = Math.floor(MAX_STATE_FILE_BYTES / 2);
  let scopeBytes = Object.entries(state).reduce(
    (total, [key, entry]) => total + Buffer.byteLength(
      JSON.stringify([key, entry]),
      'utf8',
    ),
    0,
  );
  for (const [key, entry] of Object.entries(state)) {
    const originalBytes = Buffer.byteLength(JSON.stringify([key, entry]), 'utf8');
    const fullEntry = { ...entry, lastReviewedSha: '\0'.repeat(128) };
    const fullBytes = Buffer.byteLength(JSON.stringify([key, fullEntry]), 'utf8');
    if (scopeBytes + fullBytes - originalBytes <= byteFloor) {
      state[key] = fullEntry;
      scopeBytes += fullBytes - originalBytes;
      continue;
    }
    for (let length = 1; length <= 128; length += 1) {
      const partialEntry = { ...entry, lastReviewedSha: '\0'.repeat(length) };
      const partialBytes = Buffer.byteLength(
        JSON.stringify([key, partialEntry]),
        'utf8',
      );
      if (scopeBytes + partialBytes - originalBytes > byteFloor) {
        state[key] = partialEntry;
        scopeBytes += partialBytes - originalBytes;
        break;
      }
    }
    break;
  }
  const smallestEntryBytes = Math.min(
    ...Object.entries(state).map(([key, entry]) =>
      Buffer.byteLength(JSON.stringify([key, entry]), 'utf8')),
  );
  assert.ok(scopeBytes > byteFloor);
  assert.ok(scopeBytes - byteFloor < smallestEntryBytes);
  padStateNearByteLimit(state);

  let diffCalls = 0;
  let reviewerCalls = 0;
  let postCalls = 0;
  const dependencies = successfulDependencies([]);
  dependencies.loadState = async () => state;
  dependencies.searchReviewRequestedPRs = async ({ repo }) => completeSearch(
    repo === 'other/repo' ? [{ repo, number: 1 }] : [],
  );
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'target-sha',
    number,
    title: 'Target PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  dependencies.getPullRequestDiff = async () => {
    diffCalls += 1;
    return '';
  };
  dependencies.invokeMultiPassReview = async () => {
    reviewerCalls += 1;
    return { summary: 'reviewed', findings: [] };
  };
  dependencies.postReview = async () => {
    postCalls += 1;
  };

  const result = await pollOnce({
    config: config([donor, target]),
    accountSelector: { hostname: target.hostname, username: target.username },
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'review state capacity reached');
  assert.equal(diffCalls, 0);
  assert.equal(reviewerCalls, 0);
  assert.equal(postCalls, 0);
});

for (const [label, entryCount] of [
  ['byte-only', MAX_REVIEW_STATE_ENTRIES - 1],
  ['entry-and-byte', MAX_REVIEW_STATE_ENTRIES],
]) {
  test(`${label} pressure uses exact UTF-8 admission and byte-share reclaim`, async (t) => {
    const files = await fixture(t);
    const donor = { ...work, repositories: ['owner/repo'] };
    const target = { ...personal, repositories: ['other/repo'] };
    const state = capacityState(entryCount, {
      account: donor,
      marker: true,
      shaFor: () => '\0'.repeat(128),
    });
    const initialBytes = padStateNearByteLimit(state);
    let lastSaved;
    const dependencies = successfulDependencies([]);
    dependencies.loadState = async () => state;
    dependencies.saveState = async (_path, nextState) => {
      lastSaved = structuredClone(nextState);
    };
    dependencies.searchReviewRequestedPRs = async ({ repo }) =>
      completeSearch([{ repo, number: 1 }]);
    dependencies.getPullRequest = async ({ repo, number }) => ({
      headRefOid: '€'.repeat(128),
      number,
      title: 'Unicode target',
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    });

    const result = await pollOnce({
      config: config([donor, target]),
      accountSelector: { hostname: target.hostname, username: target.username },
      ...files,
      dependencies,
    });

    assert.ok(initialBytes <= MAX_STATE_FILE_BYTES);
    assert.equal(result.failed, false);
    assert.equal(lastSaved[prKey('owner/repo', 1, donor)], undefined);
    assert.equal(
      lastSaved[prKey('other/repo', 1, target)].lastReviewedSha,
      '€'.repeat(128),
    );
    const persisted = serializeState(lastSaved);
    assert.ok(persisted.serializedBytes <= MAX_STATE_FILE_BYTES);
    assert.equal(
      Object.keys(lastSaved).filter((key) => key !== STATE_METADATA_KEY).length,
      entryCount,
    );
  });
}

test('locally ineligible proof donors do not starve selected closure GC across polls', async (t) => {
  const files = await fixture(t);
  const deconfigured = {
    hostname: 'github.com',
    username: 'retired',
    repositories: ['owner/deconfigured'],
  };
  const unselected = { ...work, repositories: ['owner/unselected'] };
  const target = { ...personal, repositories: ['owner/target'] };
  const deconfiguredEntries = 12;
  const targetEntries = MAX_STATE_GC_CHECKS_PER_POLL + 1;
  const unselectedEntries = MAX_REVIEW_STATE_ENTRIES -
    deconfiguredEntries - targetEntries;
  const state = {
    ...capacityState(deconfiguredEntries, {
      account: deconfigured,
      repo: 'owner/deconfigured',
    }),
    ...capacityState(unselectedEntries, {
      account: unselected,
      repo: 'owner/unselected',
    }),
    ...capacityState(targetEntries, {
      account: target,
      repo: 'owner/target',
      shaFor: (number) => `old-target-sha-${number}`,
    }),
  };
  const deconfiguredPrefix = prKey('owner/deconfigured', 1, deconfigured)
    .slice(0, -1);
  const unselectedPrefix = prKey('owner/unselected', 1, unselected)
    .slice(0, -1);
  const targetPrefix = prKey('owner/target', 1, target).slice(0, -1);
  const ineligibleKeys = Object.keys(state).filter((key) =>
    key.startsWith(deconfiguredPrefix) || key.startsWith(unselectedPrefix),
  );
  const targetKeys = Object.keys(state)
    .filter((key) => key.startsWith(targetPrefix))
    .sort();
  const closedKey = targetKeys[MAX_STATE_GC_CHECKS_PER_POLL];
  let persistedState = structuredClone(state);
  let saveCalls = 0;
  let unauthorizedProofCalls = 0;
  let selectedProofCalls = 0;
  let currentReconciliationCalls = 0;
  const gcKeys = [];
  let postCalls = 0;
  const newNumber = targetEntries + 1;

  function dependenciesForPoll() {
    const dependencies = successfulDependencies([]);
    dependencies.loadState = async () => structuredClone(persistedState);
    dependencies.saveState = async (_path, nextState) => {
      saveCalls += 1;
      persistedState = structuredClone(nextState);
    };
    dependencies.searchReviewRequestedPRs = async ({ repo }) => completeSearch([
      { repo, number: newNumber },
    ]);
    dependencies.getPullRequest = async ({ repo, number }) => ({
      headRefOid: `target-sha-${number}`,
      number,
      title: `Target PR ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      body: '',
      state: 'OPEN',
    });
    dependencies.reviewAlreadyPosted = async ({ repo, number }) => {
      if (repo === 'owner/target' && number === newNumber) {
        currentReconciliationCalls += 1;
      } else if (repo === 'owner/target') selectedProofCalls += 1;
      else unauthorizedProofCalls += 1;
      return false;
    };
    dependencies.getPullRequestForStateGc = async ({ repo, number }) => {
      const key = prKey(repo, number, target);
      gcKeys.push(key);
      return {
        headRefOid: `old-target-sha-${number}`,
        number,
        title: `Target PR ${number}`,
        url: `https://github.com/${repo}/pull/${number}`,
        body: '',
        state: key === closedKey ? 'CLOSED' : 'OPEN',
      };
    };
    dependencies.postReview = async ({ scheduleMutation }) =>
      scheduleMutation(async () => {
        postCalls += 1;
      });
    return dependencies;
  }

  async function runPoll() {
    return pollOnce({
      config: {
        ...config([unselected, target]),
        reviewBatchSize: 1,
      },
      accountSelector: {
        hostname: personal.hostname,
        username: personal.username,
      },
      ...files,
      dependencies: dependenciesForPoll(),
    });
  }

  const first = await runPoll();
  assert.equal(first.failed, true);
  assert.equal(first.reviewed, 0);
  assert.equal(first.failures[0].note, 'review state capacity reached');
  assert.deepEqual(gcKeys, targetKeys.slice(0, MAX_STATE_GC_CHECKS_PER_POLL));
  assert.equal(reviewStateGcAfterKey(persistedState), targetKeys[24]);
  assert.equal(saveCalls, 1);
  assert.ok(persistedState[closedKey]);

  const second = await runPoll();
  assert.equal(second.failed, true);
  assert.equal(second.reviewed, 0);
  assert.equal(second.failures[0].note, 'review state capacity reached');
  assert.equal(gcKeys[MAX_STATE_GC_CHECKS_PER_POLL], closedKey);
  assert.equal(persistedState[closedKey], undefined);
  assert.equal(saveCalls, 2);

  const third = await runPoll();
  assert.equal(third.failed, false);
  assert.equal(third.reviewed, 1);
  assert.equal(third.outcomes[0].number, newNumber);
  assert.equal(third.outcomes[0].status, 'reviewed');
  assert.equal(unauthorizedProofCalls, 0);
  assert.equal(selectedProofCalls, 0);
  assert.equal(currentReconciliationCalls, 1);
  assert.equal(postCalls, 1);
  assert.equal(saveCalls, 3);
  assert.equal(
    persistedState[prKey('owner/target', newNumber, target)].lastReviewedSha,
    `target-sha-${newNumber}`,
  );
  assert.equal(
    Object.keys(persistedState).filter((key) => key !== STATE_METADATA_KEY).length,
    MAX_REVIEW_STATE_ENTRIES,
  );
  for (const key of ineligibleKeys) assert.ok(persistedState[key]);
});

test('marker-proof cursor rolls back in memory when its atomic save fails', async (t) => {
  const files = await fixture(t);
  const donor = { ...work, repositories: ['owner/repo'] };
  const target = { ...personal, repositories: ['other/repo'] };
  const fullState = capacityState(MAX_REVIEW_STATE_ENTRIES, { account: donor });
  await saveState(files.stateFile, fullState);
  const savedStates = [];
  let observedLiveState;
  let saveCalls = 0;
  const dependencies = successfulDependencies([]);
  dependencies.saveState = async (_path, nextState) => {
    saveCalls += 1;
    observedLiveState = nextState;
    savedStates.push(structuredClone(nextState));
    if (saveCalls === 1) throw new Error('disk full');
  };
  dependencies.searchReviewRequestedPRs = async ({ repo }) => completeSearch(
    repo === 'other/repo' ? [{ repo, number: 1 }] : [],
  );
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'target-sha',
    number,
    title: 'Target PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  dependencies.reviewAlreadyPosted = async () => false;

  const result = await pollOnce({
    config: config([donor, target]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'review state capacity reached');
  assert.ok(reviewStateGcAfterKey(savedStates[0]));
  assert.equal(reviewStateGcAfterKey(observedLiveState), null);
  for (const key of Object.keys(fullState)) {
    assert.ok(observedLiveState[key]);
  }
  assert.deepEqual(JSON.parse(await readFile(files.stateFile, 'utf8')), fullState);
});

test('exact marker proof migrates and compacts an old donor before AI', async (t) => {
  const files = await fixture(t);
  const donor = { ...work, repositories: ['owner/repo'] };
  const target = { ...personal, repositories: ['other/repo'] };
  const fullState = capacityState(MAX_REVIEW_STATE_ENTRIES, { account: donor });
  let lastSaved;
  const proofNumbers = [];
  const dependencies = successfulDependencies([]);
  dependencies.loadState = async () => fullState;
  dependencies.saveState = async (_path, nextState) => {
    lastSaved = structuredClone(nextState);
  };
  dependencies.searchReviewRequestedPRs = async ({ repo }) => completeSearch(
    repo === 'other/repo' ? [{ repo, number: 1 }] : [],
  );
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'target-sha',
    number,
    title: 'Target PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  dependencies.reviewAlreadyPosted = async ({ repo, number }) => {
    if (repo === 'owner/repo') {
      proofNumbers.push(number);
      return number === 1;
    }
    return false;
  };

  const result = await pollOnce({
    config: config([donor, target]),
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.deepEqual(proofNumbers, [1]);
  assert.equal(lastSaved[prKey('owner/repo', 1, donor)], undefined);
  assert.equal(lastSaved[prKey('other/repo', 1, target)].lastReviewedSha, 'target-sha');
});

test('a compacted marker entry rehydrates on the same SHA before diff or AI', async (t) => {
  const files = await fixture(t);
  const donor = { ...work, repositories: ['owner/repo'] };
  const target = { ...personal, repositories: ['other/repo'] };
  const fullState = capacityState(MAX_REVIEW_STATE_ENTRIES, {
    account: donor,
    marker: true,
  });
  let lastSaved;
  let diffCalls = 0;
  let reviewerCalls = 0;
  let postCalls = 0;
  const timestamp = '2026-08-11T12:00:00.000Z';
  const dependencies = successfulDependencies([]);
  dependencies.now = () => Date.parse(timestamp);
  dependencies.loadState = async () => fullState;
  dependencies.saveState = async (_path, nextState) => {
    lastSaved = structuredClone(nextState);
  };
  dependencies.searchReviewRequestedPRs = async ({ repo }) =>
    completeSearch([{ repo, number: 1 }]);
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'already-posted-sha',
    number,
    title: 'Recovered PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  dependencies.reviewAlreadyPosted = async ({ repo }) => repo === 'other/repo';
  dependencies.getPullRequestDiff = async () => {
    diffCalls += 1;
    return '';
  };
  dependencies.invokeMultiPassReview = async () => {
    reviewerCalls += 1;
    return { summary: 'reviewed', findings: [] };
  };
  dependencies.postReview = async () => {
    postCalls += 1;
  };

  const result = await pollOnce({
    config: config([donor, target]),
    accountSelector: { hostname: target.hostname, username: target.username },
    ...files,
    dependencies,
  });

  assert.equal(result.failed, false);
  assert.equal(result.outcomes[0].status, 'recovered');
  assert.equal(diffCalls, 0);
  assert.equal(reviewerCalls, 0);
  assert.equal(postCalls, 0);
  assert.deepEqual(lastSaved[prKey('other/repo', 1, target)], {
    lastReviewedSha: 'already-posted-sha',
    lastReviewedAt: timestamp,
    reviewMarkerVersion: 1,
  });
});

test('compaction save failure retains donors and stops before AI', async (t) => {
  const files = await fixture(t);
  const donor = { ...work, repositories: ['owner/repo'] };
  const target = { ...personal, repositories: ['other/repo'] };
  const fullState = capacityState(MAX_REVIEW_STATE_ENTRIES, {
    account: donor,
    marker: true,
  });
  let diffCalls = 0;
  let reviewerCalls = 0;
  const dependencies = successfulDependencies([]);
  dependencies.loadState = async () => fullState;
  dependencies.saveState = async () => {
    throw new Error('disk full');
  };
  dependencies.searchReviewRequestedPRs = async ({ repo }) =>
    completeSearch([{ repo, number: 1 }]);
  dependencies.getPullRequest = async ({ repo, number }) => ({
    headRefOid: 'target-sha',
    number,
    title: 'Target PR',
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    state: 'OPEN',
  });
  dependencies.getPullRequestDiff = async () => {
    diffCalls += 1;
    return '';
  };
  dependencies.invokeMultiPassReview = async () => {
    reviewerCalls += 1;
    return { summary: 'reviewed', findings: [] };
  };

  const result = await pollOnce({
    config: config([donor, target]),
    accountSelector: { hostname: target.hostname, username: target.username },
    ...files,
    dependencies,
  });

  assert.equal(result.failed, true);
  assert.equal(result.failures[0].note, 'review state capacity reached');
  assert.equal(diffCalls, 0);
  assert.equal(reviewerCalls, 0);
  assert.ok(fullState[prKey('owner/repo', 1, donor)]);
  assert.equal(fullState[prKey('other/repo', 1, target)], undefined);
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

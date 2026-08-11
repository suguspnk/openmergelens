import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import {
  createReviewMarker,
  diffAnchors,
  getPullRequest,
  getPullRequestDiff,
  hasActiveReviewRequest,
  isValidatedReviewRequestSearchResult,
  postReview,
  prepareReview,
  retryMetadataFromDiagnostic,
  reviewAlreadyPosted,
  searchReviewRequestedPRs,
} from '../lib/github.mjs';
import { normalizeReviewObject } from '../lib/reviewer-adapter.mjs';
import {
  REVIEW_MUTATION_BOUNDARY_CODE,
  ReviewMutationBoundaryError,
} from '../lib/review-mutation-boundary.mjs';
import {
  createGitHubMutationQueue,
  MAX_TIMER_DELAY_MS,
} from '../lib/github-mutation-queue.mjs';
import {
  MAX_ACTIVE_REVIEW_REQUEST_USERS,
  MAX_DIFF_ANCHORS,
} from '../lib/security-limits.mjs';

function mockGhStdout(t, outputs) {
  let callIndex = 0;
  t.mock.method(childProcess, 'spawn', () => {
    const output = outputs[callIndex];
    callIndex += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write() {},
      end() {},
    };
    process.nextTick(() => {
      if (output !== undefined) child.stdout.emit('data', Buffer.from(output));
      child.emit('close', 0);
    });
    return child;
  });
  return () => callIndex;
}

test('any normalized review fits the posting body when all findings are unanchored', async () => {
  const normalized = normalizeReviewObject({
    summary: 's'.repeat(16_000),
    findings: Array.from({ length: 50 }, (_, index) => ({
      path: `dir/${String(index).padStart(2, '0')}-${'p'.repeat(500)}`,
      line: index + 1,
      severity: 'major',
      comment: 'c'.repeat(4_000),
    })),
  });
  let postedBody;

  await postReview({
    repo: 'owner/repo',
    number: 7,
    commitId: 'abc123',
    body: normalized.summary,
    comments: normalized.findings,
    diff: '',
    marker: '<!-- openmergelens:test -->',
    auth: { hostname: 'github.com', username: 'octocat', token: 'test-token' },
    scheduleMutation: (operation) => operation(),
    request: async (_args, { input }) => {
      postedBody = JSON.parse(input).body;
    },
  });

  assert.ok(postedBody.length <= 60_000);
});

test('explicit repository search preserves concatenated paginated gh output', async (t) => {
  let command;
  let args;
  let spawnCount = 0;
  t.mock.method(childProcess, 'spawn', (spawnCommand, spawnArgs) => {
    spawnCount += 1;
    command = spawnCommand;
    args = spawnArgs;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write() {},
      end() {},
    };
    process.nextTick(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          'meta|2|false\n' +
          'https://api.github.com/repos/acme/first|7\n' +
          'https://api.github.com/repos/acme/first|8\n',
        ),
      );
      child.emit('close', 0);
    });
    return child;
  });

  const results = await searchReviewRequestedPRs({
    username: 'sera240910',
    repo: 'acme/first',
  });
  assert.deepEqual(results, [
    { repo: 'acme/first', number: 7 },
    { repo: 'acme/first', number: 8 },
  ]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(results, 'complete'), {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  assert.equal(Array.isArray(results), true);
  assert.equal(isValidatedReviewRequestSearchResult(results), true);
  const descriptorClone = [...results];
  Object.defineProperty(
    descriptorClone,
    'complete',
    Object.getOwnPropertyDescriptor(results, 'complete'),
  );
  assert.equal(isValidatedReviewRequestSearchResult(descriptorClone), false);
  assert.equal(Object.isFrozen(results), true);
  assert.equal(Object.isFrozen(results[0]), true);
  assert.throws(() => {
    results[0].repo = 'acme/other';
  }, TypeError);
  assert.throws(() => {
    results.push({ repo: 'acme/first', number: 9 });
  }, TypeError);
  assert.deepEqual(results, [
    { repo: 'acme/first', number: 7 },
    { repo: 'acme/first', number: 8 },
  ]);

  assert.equal(command, 'gh');
  assert.equal(spawnCount, 1);
  assert.ok(args.includes('--paginate'));
  assert.ok(args.includes('--jq'));
  assert.ok(args.includes('q=is:pr is:open review-requested:sera240910 repo:acme/first'));
  assert.ok(args.some((arg) => arg.includes('.repository_url')));
});

test('capped review-requested search fails closed without a fallback', async (t) => {
  const spawnCount = mockGhStdout(t, [
    'meta|1001|false\nhttps://api.github.com/repos/acme/repo|1\n',
  ]);

  await assert.rejects(
    searchReviewRequestedPRs({ username: 'octocat', repo: 'acme/repo' }),
    /did not provide a complete result set/u,
  );
  assert.equal(spawnCount(), 1);
});

test('complete multi-page review-requested search proves every result', async (t) => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    `https://api.github.com/repos/acme/repo|${index + 1}`
  ).join('\n');
  const spawnCount = mockGhStdout(t, [
    `meta|101|false\n${firstPage}\nmeta|101|false\n` +
      'https://api.github.com/repos/acme/repo|101\n',
  ]);

  const results = await searchReviewRequestedPRs({
    username: 'octocat',
    repo: 'acme/repo',
  });

  assert.equal(results.complete, true);
  assert.equal(results.length, 101);
  assert.deepEqual(results.at(-1), { repo: 'acme/repo', number: 101 });
  assert.equal(spawnCount(), 1);
});

test('empty review-requested search is completeness-proven', async (t) => {
  mockGhStdout(t, ['meta|0|false\n']);

  const results = await searchReviewRequestedPRs({
    username: 'octocat',
    repo: 'acme/repo',
  });

  assert.deepEqual(results, []);
  assert.equal(results.complete, true);
});

for (const [label, encoding] of [
  ['empty', ''],
  ['whitespace-only', ' '],
  ['leading whitespace', ' 1'],
  ['trailing whitespace', '1 '],
  ['exponent', '1e0'],
  ['positive sign', '+1'],
  ['negative sign', '-1'],
  ['decimal', '1.0'],
  ['leading zero', '01'],
  ['unsafe integer', '9007199254740992'],
]) {
  test(`review-requested search rejects ${label} total_count encoding`, async (t) => {
    mockGhStdout(t, [`meta|${encoding}|false\n`]);

    await assert.rejects(
      searchReviewRequestedPRs({ username: 'octocat', repo: 'acme/repo' }),
      /malformed result metadata/u,
    );
  });
}

for (const [label, encoding] of [
  ['empty', ''],
  ['whitespace-only', ' '],
  ['leading whitespace', ' 1'],
  ['trailing whitespace', '1 '],
  ['exponent', '1e0'],
  ['positive sign', '+1'],
  ['negative sign', '-1'],
  ['decimal', '1.0'],
  ['zero', '0'],
  ['leading zero', '01'],
  ['unsafe integer', '9007199254740992'],
]) {
  test(`review-requested search rejects ${label} PR number encoding`, async (t) => {
    mockGhStdout(t, [
      `meta|1|false\nhttps://api.github.com/repos/acme/repo|${encoding}\n`,
    ]);

    await assert.rejects(
      searchReviewRequestedPRs({ username: 'octocat', repo: 'acme/repo' }),
      /malformed pull request candidate/u,
    );
  });
}

for (const { label, output, error } of [
  {
    label: 'changing total_count metadata',
    output:
      'meta|2|false\n' +
      'https://api.github.com/repos/acme/repo|7\n' +
      'meta|1|false\n',
    error: /inconsistent pagination metadata/u,
  },
  {
    label: 'changing incomplete_results metadata',
    output:
      'meta|1|false\n' +
      'https://api.github.com/repos/acme/repo|7\n' +
      'meta|1|true\n',
    error: /inconsistent pagination metadata/u,
  },
  {
    label: 'candidate output without metadata',
    output: 'https://api.github.com/repos/acme/repo|7\n',
    error: /candidate without result metadata/u,
  },
  {
    label: 'missing incomplete_results metadata',
    output:
      'meta|1|null\n' +
      'https://api.github.com/repos/acme/repo|7\n',
    error: /malformed result metadata/u,
  },
  {
    label: 'foreign repository candidates',
    output:
      'meta|1|false\n' +
      'https://api.github.com/repos/acme/other|7\n',
    error: /foreign pull request candidate/u,
  },
  {
    label: 'duplicate candidates',
    output:
      'meta|2|false\n' +
      'https://api.github.com/repos/acme/repo|7\n' +
      'https://api.github.com/repos/ACME/REPO|7\n',
    error: /duplicate pull request candidate/u,
  },
  {
    label: 'candidate-count mismatch',
    output:
      'meta|2|false\n' +
      'https://api.github.com/repos/acme/repo|7\n',
    error: /candidate count did not match result metadata/u,
  },
  {
    label: 'missing page metadata',
    output: `meta|101|false\n${Array.from({ length: 101 }, (_, index) =>
      `https://api.github.com/repos/acme/repo|${index + 1}`
    ).join('\n')}\n`,
    error: /incomplete pagination metadata/u,
  },
]) {
  test(`review-requested search rejects ${label}`, async (t) => {
    mockGhStdout(t, [output]);

    await assert.rejects(
      searchReviewRequestedPRs({ username: 'octocat', repo: 'acme/repo' }),
      error,
    );
  });
}

test('incomplete search metadata fails closed without a fallback', async (t) => {
  const spawnCount = mockGhStdout(t, [
    'meta|2|true\nhttps://api.github.com/repos/acme/repo|7\n',
  ]);

  await assert.rejects(
    searchReviewRequestedPRs({ username: 'octocat', repo: 'acme/repo' }),
    /did not provide a complete result set/u,
  );
  assert.equal(spawnCount(), 1);
});

test('pull request metadata includes the current state', async (t) => {
  let args;
  t.mock.method(childProcess, 'spawn', (_spawnCommand, spawnArgs) => {
    args = spawnArgs;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write() {},
      end() {},
    };
    process.nextTick(() => {
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({
          headRefOid: 'sha-1',
          number: 7,
          state: 'OPEN',
        })),
      );
      child.emit('close', 0);
    });
    return child;
  });

  const pullRequest = await getPullRequest({
    repo: 'owner/repo',
    number: 7,
  });

  assert.equal(pullRequest.state, 'OPEN');
  const fields = args[args.indexOf('--json') + 1].split(',');
  assert.ok(fields.includes('state'));
});

test('active review-request lookup matches an exact login case-insensitively', async () => {
  let requestedArgs;
  const active = await hasActiveReviewRequest({
    repo: 'Owner/Repo',
    number: 7,
    username: 'OctoCat',
    auth: { hostname: 'github.com', username: 'octocat', token: 'token' },
    request: async (args) => {
      requestedArgs = args;
      return [
        JSON.stringify({ login: 'someone-else' }),
        JSON.stringify({ login: 'octocat' }),
      ].join('\n');
    },
  });

  assert.equal(active, true);
  assert.ok(requestedArgs.includes('/repos/Owner/Repo/pulls/7/requested_reviewers'));
  assert.ok(requestedArgs.includes('--paginate'));
  assert.equal(
    await hasActiveReviewRequest({
      repo: 'owner/repo',
      number: 7,
      username: 'octocat',
      request: async () => JSON.stringify({ login: 'octocat-team' }),
    }),
    false,
  );
});

for (const [label, output] of [
  ['missing login', '{}'],
  ['non-string login', JSON.stringify({ login: 7 })],
  ['non-object user', 'null'],
  ['whitespace-padded login', JSON.stringify({ login: ' octocat ' })],
  ['invalid login', JSON.stringify({ login: 'octo.cat' })],
  ['invalid JSON', '{'],
]) {
  test(`active review-request lookup rejects ${label}`, async () => {
    await assert.rejects(
      hasActiveReviewRequest({
        repo: 'owner/repo',
        number: 7,
        username: 'octocat',
        request: async () => output,
      }),
      /requested reviewers response is malformed/u,
    );
  });
}

test('active review-request lookup rejects oversized user lists and API failures', async () => {
  const oversized = Array.from(
    { length: MAX_ACTIVE_REVIEW_REQUEST_USERS + 1 },
    (_, index) => JSON.stringify({ login: `user-${index}` }),
  ).join('\n');
  await assert.rejects(
    hasActiveReviewRequest({
      repo: 'owner/repo',
      number: 7,
      username: 'octocat',
      request: async () => oversized,
    }),
    /exceeded 1000 users/u,
  );
  await assert.rejects(
    hasActiveReviewRequest({
      repo: 'owner/repo',
      number: 7,
      username: 'octocat',
      request: async () => { throw new Error('HTTP 503'); },
    }),
    /HTTP 503/u,
  );
});

test('active review-request lookup validates every returned user after a match', async () => {
  await assert.rejects(
    hasActiveReviewRequest({
      repo: 'owner/repo',
      number: 7,
      username: 'octocat',
      request: async () => [
        JSON.stringify({ login: 'octocat' }),
        JSON.stringify({ login: 7 }),
      ].join('\n'),
    }),
    /requested reviewers response is malformed/u,
  );
});

test('gh subprocess preserves signal termination metadata', async (t) => {
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write() {},
      end() {},
    };
    process.nextTick(() => child.emit('close', null, 'SIGTERM'));
    return child;
  });

  let failure;
  await assert.rejects(
    getPullRequest({ repo: 'owner/repo', number: 7 }),
    (error) => {
      failure = error;
      return error.signal === 'SIGTERM' &&
        error.exitCode === null &&
        error.cause?.signal === 'SIGTERM' &&
        /exited SIGTERM$/.test(error.cause.message);
    },
  );
  assert.equal(failure.signal, 'SIGTERM');
  assert.equal(failure.exitCode, null);
});

test('gh subprocess preserves UTF-8 split across diff and metadata chunks', async (t) => {
  const outputs = [
    Buffer.from('diff --git a/café.txt b/café.txt\n'),
    Buffer.from(JSON.stringify({ title: 'café', state: 'OPEN' })),
  ];
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write() {},
      end() {},
    };
    const output = outputs.shift();
    process.nextTick(() => {
      const splitAt = output.indexOf(0xc3) + 1;
      child.stdout.emit('data', output.subarray(0, splitAt));
      child.stdout.emit('data', output.subarray(splitAt));
      child.emit('close', 0);
    });
    return child;
  });

  const diff = await getPullRequestDiff({ repo: 'owner/repo', number: 7 });
  const metadata = await getPullRequest({ repo: 'owner/repo', number: 7 });

  assert.equal(diff, 'diff --git a/café.txt b/café.txt\n');
  assert.equal(metadata.title, 'café');
});

test('gh subprocess output is bounded before parsing', async (t) => {
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => {};
    child.stdin.end = () => {};
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.alloc(32 * 1024 * 1024 + 1));
      child.emit('close', null);
    });
    return child;
  });

  await assert.rejects(
    searchReviewRequestedPRs({
      username: 'octocat',
      repo: 'owner/repo',
    }),
    /stdout exceeded/,
  );
});

test('GitHub response headers expose Retry-After and rate-reset timing', () => {
  assert.deepEqual(
    retryMetadataFromDiagnostic(
      'HTTP/2.0 429 Too Many Requests\r\n' +
      'retry-after: 7\r\n' +
      'x-ratelimit-reset: 2000000000\r\n',
    ),
    {
      retryAfterMs: 7_000,
      rateLimitResetAtMs: 2_000_000_000_000,
    },
  );
});

test('GitHub retry metadata bounds oversized timer values', () => {
  assert.deepEqual(
    retryMetadataFromDiagnostic(
      'HTTP/2.0 429 Too Many Requests\r\n' +
      'retry-after: 3000000000\r\n' +
      'x-ratelimit-reset: 999999999999999999999999\r\n',
    ),
    {
      retryAfterMs: MAX_TIMER_DELAY_MS,
      rateLimitResetAtMs: undefined,
    },
  );
});

const account = {
  hostname: 'github.com',
  username: 'octocat',
};

function reviewOptions(overrides = {}) {
  return {
    repo: 'owner/repo',
    number: 7,
    commitId: 'sha-1',
    body: 'Review summary',
    comments: [{
      path: 'file.js',
      line: 1,
      severity: 'major',
      comment: 'Fix this',
    }],
    diff: '+++ b/file.js\n@@ -0,0 +1 @@\n+line\n',
    marker: createReviewMarker({
      account,
      repo: 'owner/repo',
      number: 7,
      commitId: 'sha-1',
    }),
    auth: { ...account, token: 'test-token' },
    scheduleMutation: (operation) => operation(),
    ...overrides,
  };
}

test('postReview requires mutation scheduling at its GitHub write boundary', async () => {
  const { scheduleMutation: _scheduleMutation, ...options } = reviewOptions();
  await assert.rejects(
    postReview(options),
    /requires a GitHub mutation scheduler/,
  );
});

for (const reason of ['stale', 'closed', 'revoked']) {
  test(`postReview rethrows a ${reason} mutation-boundary sentinel before reconciliation`, async () => {
    const calls = [];
    const options = reviewOptions({
      scheduleMutation: async () => {
        throw new ReviewMutationBoundaryError(reason);
      },
      request: async (args) => {
        calls.push(args[args.indexOf('--method') + 1]);
        return '';
      },
    });

    await assert.rejects(
      postReview(options),
      (error) =>
        error instanceof ReviewMutationBoundaryError &&
        error.code === REVIEW_MUTATION_BOUNDARY_CODE &&
        error.reason === reason,
    );
    assert.deepEqual(calls, []);
  });
}

test('postReview keeps the fallback mutation boundary guarded', async () => {
  const calls = [];
  let mutationCount = 0;
  const options = reviewOptions({
    scheduleMutation: async (operation) => {
      mutationCount += 1;
      if (mutationCount === 3) {
        throw new ReviewMutationBoundaryError('stale');
      }
      return operation();
    },
    request: async (args) => {
      const method = args[args.indexOf('--method') + 1];
      calls.push(method);
      if (method === 'GET') return '';
      throw Object.assign(new Error('HTTP 422: Validation Failed'), { status: 422 });
    },
  });

  await assert.rejects(
    postReview(options),
    (error) =>
      error instanceof ReviewMutationBoundaryError &&
      error.reason === 'stale',
  );
  assert.deepEqual(calls, ['POST', 'GET']);
  assert.equal(mutationCount, 3);
});

test('prepareReview shares posting validation and diff-anchor classification', () => {
  const prepared = prepareReview({
    ...reviewOptions(),
    comments: [
      ...reviewOptions().comments,
      {
        path: 'missing.js',
        line: 99,
        severity: 'major',
        comment: 'Unanchored finding',
      },
    ],
    diff: '+++ b/file.js\n@@ -0,0 +1 @@\n+line\n',
  });

  assert.equal(prepared.anchorable.length, 1);
  assert.equal(prepared.unanchorable.length, 1);
  assert.equal(prepared.payload.comments.length, 1);
  assert.match(prepared.reviewBody, /Additional findings \(could not anchor to a diff line\)/);
  assert.match(prepared.reviewBody, /missing\.js:99/);
});

test('diff anchor parsing fails closed before retaining too many anchors', () => {
  const lineCount = MAX_DIFF_ANCHORS + 1;
  const diff = `+++ b/large.js\n@@ -0,${lineCount} +1,${lineCount} @@\n` +
    '+line\n'.repeat(lineCount);

  assert.deepEqual(diffAnchors(diff), new Set());

  const prepared = prepareReview({
    ...reviewOptions(),
    comments: [{
      path: 'large.js',
      line: 1,
      severity: 'major',
      comment: 'Large diff finding',
    }],
    diff,
  });
  assert.equal(prepared.anchorable.length, 0);
  assert.equal(prepared.unanchorable.length, 1);
});

test('diff anchor parsing preserves normal multi-file hunk anchors', () => {
  const diff = [
    '+++ b/first.js',
    '@@ -1,3 +1,3 @@',
    ' context',
    '-removed',
    '+added',
    ' trailing context',
    '+++ b/second.js',
    '@@ -8,0 +9,2 @@',
    '+second one',
    '+second two',
  ].join('\n');

  assert.deepEqual([...diffAnchors(diff)], [
    'first.js:1',
    'first.js:2',
    'first.js:3',
    'second.js:9',
    'second.js:10',
  ]);
});

test('diff anchor parsing treats header-looking added lines as source content', () => {
  const diff = [
    '+++ b/source.js',
    '@@ -0,0 +1,2 @@',
    '+++ b/not-a-header.js',
    '+following source',
  ].join('\n');

  assert.deepEqual([...diffAnchors(diff)], [
    'source.js:1',
    'source.js:2',
  ]);
});

test('review markers are stable across GitHub identifier casing and scoped to a commit', () => {
  const lower = createReviewMarker({
    account,
    repo: 'owner/repo',
    number: 7,
    commitId: 'sha-1',
  });
  const differentlyCased = createReviewMarker({
    account: { hostname: 'GITHUB.COM', username: 'OctoCat' },
    repo: 'OWNER/REPO',
    number: 7,
    commitId: 'sha-1',
  });
  const nextCommit = createReviewMarker({
    account,
    repo: 'owner/repo',
    number: 7,
    commitId: 'sha-2',
  });

  assert.equal(lower, differentlyCased);
  assert.notEqual(lower, nextCommit);
  assert.match(lower, /^<!-- openmergelens-review:[a-f0-9]{64} -->$/);
});

test('reviewAlreadyPosted matches both marker and commit across paginated JSON lines', async () => {
  const options = reviewOptions();
  const request = async () => [
    JSON.stringify({
      body: options.marker,
      commit_id: options.commitId,
      state: 'PENDING',
      user_login: options.auth.username,
    }),
    JSON.stringify({
      body: options.marker,
      commit_id: 'older-sha',
      state: 'COMMENTED',
      user_login: options.auth.username,
    }),
    JSON.stringify({
      body: `summary\n${options.marker}`,
      commit_id: options.commitId,
      state: 'COMMENTED',
      user_login: options.auth.username,
    }),
  ].join('\n');

  assert.equal(await reviewAlreadyPosted({ ...options, request }), true);
});

test('reviewAlreadyPosted rejects a forged marker from a different reviewer', async () => {
  const options = reviewOptions();
  const request = async () => JSON.stringify({
    body: options.marker,
    commit_id: options.commitId,
    state: 'COMMENTED',
    user_login: 'attacker',
  });

  assert.equal(await reviewAlreadyPosted({ ...options, request }), false);
});

test('postReview does not retry a non-validation failure', async () => {
  const calls = [];
  const request = async (args) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    if (method === 'POST') throw new Error('connection reset');
    return '';
  };

  await assert.rejects(
    postReview({ ...reviewOptions(), request }),
    /connection reset/,
  );
  assert.deepEqual(calls, ['POST', 'GET']);
});

test('postReview stops immediately when GitHub rate-limits the mutation', async () => {
  const calls = [];
  const request = async (args) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    throw Object.assign(new Error('secondary rate limit'), {
      status: 403,
      retryAfterMs: 60_000,
    });
  };

  await assert.rejects(
    postReview({ ...reviewOptions(), request }),
    /secondary rate limit/,
  );
  assert.deepEqual(calls, ['POST']);
});

test('postReview puts reconciliation rate limits into the mutation queue backoff', async () => {
  let clock = 20_000;
  const sleeps = [];
  const calls = [];
  const reconciliationError = Object.assign(
    new Error('HTTP 429: Too Many Requests'),
    { status: 429, retryAfterMs: 5_000, rateLimitResetAtMs: 60_000 },
  );
  const queue = createGitHubMutationQueue({
    minIntervalMs: 1_000,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });
  const request = async (args) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    if (method === 'POST') {
      throw Object.assign(new Error('HTTP 422: Validation Failed'), { status: 422 });
    }
    throw reconciliationError;
  };

  let failure;
  await assert.rejects(
    postReview({
      ...reviewOptions(),
      request,
      scheduleMutation: (operation) => queue.run(operation),
    }),
    (error) => {
      failure = error;
      return error.status === 429 &&
        error.retryAfterMs === 5_000 &&
        error.rateLimitResetAtMs === 60_000 &&
        error.cause === reconciliationError &&
        error.originalError?.status === 422;
    },
  );

  let nextMutationStartedAt;
  await queue.run(async () => {
    nextMutationStartedAt = clock;
  });

  assert.equal(failure.cause, reconciliationError);
  assert.deepEqual(calls, ['POST', 'GET']);
  assert.deepEqual(sleeps, [1_000, 5_000]);
  assert.equal(nextMutationStartedAt, 26_000);
});

test('postReview fallback stops without reconciliation when GitHub rate-limits it', async () => {
  const calls = [];
  let postCount = 0;
  const request = async (args) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    if (method === 'GET') return '';
    postCount += 1;
    if (postCount === 1) {
      throw Object.assign(new Error('Validation Failed'), { status: 422 });
    }
    throw Object.assign(new Error('secondary rate limit'), { status: 429 });
  };

  await assert.rejects(
    postReview({ ...reviewOptions(), request }),
    /secondary rate limit/,
  );
  assert.deepEqual(calls, ['POST', 'GET', 'POST']);
});

test('postReview treats an ambiguously successful request as complete after reconciliation', async () => {
  const options = reviewOptions();
  const calls = [];
  const scheduledOperations = [];
  let submitted;
  const request = async (args, requestOptions) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    if (method === 'POST') {
      submitted = JSON.parse(requestOptions.input);
      throw new Error('connection reset after response');
    }
    return JSON.stringify({
      body: submitted.body,
      commit_id: options.commitId,
      state: 'COMMENTED',
      user_login: options.auth.username,
    });
  };

  await postReview({
    ...options,
    request,
    scheduleMutation: async (operation, options) => {
      scheduledOperations.push(options);
      return operation();
    },
  });
  assert.deepEqual(calls, ['POST', 'GET']);
  assert.deepEqual(scheduledOperations, [
    { mutation: true },
    { mutation: false },
  ]);
  assert.match(submitted.body, new RegExp(options.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(
    submitted.body,
    /AI-generated review:.*OpenMergeLens.*on behalf of @octocat/,
  );
});

test('postReview retries without inline comments only for an unreconciled 422', async () => {
  const calls = [];
  const payloads = [];
  const scheduledOperations = [];
  const request = async (args, requestOptions) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    if (method === 'GET') return '';
    payloads.push(JSON.parse(requestOptions.input));
    if (payloads.length === 1) {
      throw Object.assign(new Error('HTTP 422: Validation Failed'), { status: 422 });
    }
    return '{}';
  };

  await postReview({
    ...reviewOptions(),
    request,
    scheduleMutation: async (operation, options) => {
      scheduledOperations.push(options);
      return operation();
    },
  });

  assert.deepEqual(calls, ['POST', 'GET', 'POST']);
  assert.deepEqual(scheduledOperations, [
    { mutation: true },
    { mutation: false },
    { mutation: true },
  ]);
  assert.equal(payloads[0].comments.length, 1);
  assert.deepEqual(payloads[1].comments, []);
  assert.match(payloads[1].body, /All findings/);
});

test('postReview rejects unsafe finding fields at the posting boundary', async () => {
  await assert.rejects(
    postReview({
      ...reviewOptions(),
      comments: [{
        path: 'file.js',
        line: 1,
        severity: 'urgent',
        comment: 'unsafe',
      }],
    }),
    /invalid or unsafe finding/,
  );
});

test('postReview does not retry a 422 when no inline comment can be demoted', async () => {
  const calls = [];
  const request = async (args) => {
    const method = args[args.indexOf('--method') + 1];
    calls.push(method);
    if (method === 'GET') return '';
    throw Object.assign(new Error('HTTP 422: Validation Failed'), { status: 422 });
  };

  await assert.rejects(
    postReview({
      ...reviewOptions(),
      comments: [],
      request,
    }),
    /HTTP 422/,
  );
  assert.deepEqual(calls, ['POST', 'GET']);
});

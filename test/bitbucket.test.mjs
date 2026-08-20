import test from 'node:test';
import assert from 'node:assert/strict';
import { ADDRCONFIG } from 'node:dns';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import {
  bitbucketRequest,
  bitbucketLookup,
  bitbucketReviewAlreadyPosted,
  createBitbucketReviewMarker,
  getBitbucketPullRequest,
  listAccessibleBitbucketRepos,
  postBitbucketReview,
  prepareBitbucketReview,
  searchBitbucketReviewRequestedPRs,
} from '../lib/bitbucket.mjs';
import { createGitHubMutationQueue } from '../lib/github-mutation-queue.mjs';

const account = {
  accountId: '{123e4567-e89b-42d3-a456-426614174000}',
};
const auth = { ...account, username: 'reviewer@example.com', password: 'secret' };

test('Bitbucket repository discovery returns canonical searchable member repositories', async () => {
  const calls = [];
  const repos = await listAccessibleBitbucketRepos({
    auth,
    api: async ({ path }) => {
      calls.push(path);
      return {
        values: [{ full_name: 'Workspace/Repo', is_private: true }],
      };
    },
  });
  assert.deepEqual(calls, ['/2.0/repositories?role=member&pagelen=50&sort=full_name']);
  assert.deepEqual(repos, [{ nameWithOwner: 'Workspace/Repo', isPrivate: true }]);
});

test('Bitbucket repository discovery rejects malformed metadata', async () => {
  await assert.rejects(
    listAccessibleBitbucketRepos({
      auth,
      api: async () => ({ values: [{ full_name: 'missing-slash' }] }),
    }),
    /repository response is malformed/u,
  );
});

test('Bitbucket lookup prefers IPv4 while preserving IPv4-only and IPv6-only resolution', async (t) => {
  const requestOptions = { all: true, family: 0, hints: ADDRCONFIG };
  const resolve = (records, failure) => new Promise((resolveAddresses, rejectAddresses) => {
    const lookup = (hostname, options, callback) => {
      assert.equal(hostname, 'api.bitbucket.org');
      assert.deepEqual(options, { ...requestOptions, order: 'ipv4first' });
      if (failure) {
        callback(failure);
        return;
      }
      const ordered = [...records].sort((left, right) => left.family - right.family);
      callback(null, ordered);
    };
    bitbucketLookup('api.bitbucket.org', requestOptions, (error, addresses) => {
      if (error) rejectAddresses(error);
      else resolveAddresses(addresses);
    }, lookup);
  });

  await t.test('dual stack chooses IPv4', async () => {
    assert.deepEqual(await resolve([
      { address: '2001:db8::1', family: 6 },
      { address: '192.0.2.1', family: 4 },
    ]), [
      { address: '192.0.2.1', family: 4 },
      { address: '2001:db8::1', family: 6 },
    ]);
  });
  await t.test('IPv6-only remains usable', async () => {
    assert.deepEqual(await resolve([
      { address: '2001:db8::1', family: 6 },
    ]), [{ address: '2001:db8::1', family: 6 }]);
  });
  await t.test('IPv4-only remains usable', async () => {
    assert.deepEqual(await resolve([
      { address: '192.0.2.1', family: 4 },
    ]), [{ address: '192.0.2.1', family: 4 }]);
  });
  await t.test('DNS errors fail closed', async () => {
    await assert.rejects(resolve([], new Error('DNS failed')), /DNS failed/u);
  });
});

test('one request falls back from IPv4 to an IPv6-only loopback server without replaying its body', async (t) => {
  const payload = JSON.stringify({ content: { raw: 'review comment' } });
  let serverRequests = 0;
  let receivedBody = '';
  const server = createServer((request, response) => {
    serverRequests += 1;
    request.setEncoding('utf8');
    request.on('data', (chunk) => { receivedBody += chunk; });
    request.on('end', () => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"id":42}');
    });
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen({ host: '::1', port: 0, ipv6Only: true }, resolveListen);
    });
  } catch (error) {
    if (error?.code === 'EAFNOSUPPORT' || error?.code === 'EADDRNOTAVAIL') {
      t.skip('IPv6 loopback is unavailable on this host');
      return;
    }
    throw error;
  }
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));

  let wrapperCalls = 0;
  let resolverCalls = 0;
  let clientWrites = 0;
  const resolver = (hostname, options, callback) => {
    resolverCalls += 1;
    assert.equal(hostname, 'fallback.test');
    assert.equal(options.all, true);
    assert.equal(options.order, 'ipv4first');
    callback(null, [
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
  };
  const lookup = (hostname, options, callback) => {
    wrapperCalls += 1;
    return bitbucketLookup(hostname, options, callback, resolver);
  };
  const responseBody = await new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest({
      hostname: 'fallback.test',
      port: server.address().port,
      method: 'POST',
      lookup,
      autoSelectFamily: true,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveResponse(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', rejectResponse);
    clientWrites += 1;
    request.write(payload);
    request.end();
  });

  assert.equal(responseBody, '{"id":42}');
  assert.equal(wrapperCalls, 1);
  assert.equal(resolverCalls, 1);
  assert.equal(clientWrites, 1);
  assert.equal(serverRequests, 1);
  assert.equal(receivedBody, payload);
});

test('Bitbucket REST boundary pins HTTPS, API host, and bounded API paths', async () => {
  let options;
  let timeoutMs;
  const request = (supplied, callback) => {
    options = supplied;
    const req = new EventEmitter();
    req.setTimeout = (value) => { timeoutMs = value; };
    req.write = () => {};
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = {};
      callback(response);
      response.end('{"uuid":"account"}');
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
  assert.deepEqual(
    await bitbucketRequest({ auth, path: '/2.0/user', request }),
    { uuid: 'account' },
  );
  assert.equal(options.protocol, 'https:');
  assert.equal(options.hostname, 'api.bitbucket.org');
  assert.equal(options.port, 443);
  assert.equal('family' in options, false);
  assert.equal(options.lookup, bitbucketLookup);
  assert.equal(options.autoSelectFamily, true);
  assert.equal(options.method, 'GET');
  assert.equal(
    options.headers.authorization,
    `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
  );
  assert.equal(timeoutMs, 15_000);
  assert.throws(
    () => bitbucketRequest({ auth, path: 'https://attacker.example/2.0/user', request }),
    /path is invalid/u,
  );
});

test('Bitbucket comment POST uses the IPv4-first boundary once with one serialized body', async () => {
  const suppliedOptions = [];
  const writes = [];
  let timeoutMs;
  const request = (options, callback) => {
    suppliedOptions.push(options);
    const req = new EventEmitter();
    req.setTimeout = (value) => { timeoutMs = value; };
    req.write = (value) => { writes.push(value); };
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = 201;
      response.headers = {};
      callback(response);
      response.end('{"id":42}');
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
  const body = { content: { raw: 'review comment' } };
  assert.deepEqual(await bitbucketRequest({
    auth,
    method: 'POST',
    path: '/2.0/repositories/workspace/repo/pullrequests/7/comments',
    body,
    request,
  }), { id: 42 });
  assert.equal(suppliedOptions.length, 1);
  assert.equal('family' in suppliedOptions[0], false);
  assert.equal(suppliedOptions[0].lookup, bitbucketLookup);
  assert.equal(suppliedOptions[0].autoSelectFamily, true);
  assert.equal(suppliedOptions[0].protocol, 'https:');
  assert.equal(suppliedOptions[0].hostname, 'api.bitbucket.org');
  assert.equal(suppliedOptions[0].port, 443);
  assert.equal(suppliedOptions[0].method, 'POST');
  assert.equal(timeoutMs, 15_000);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].toString('utf8')), body);
});

test('Bitbucket POST timeout and request errors never replay the mutation', async (t) => {
  for (const failure of ['timeout', 'error']) await t.test(failure, async () => {
    let requests = 0;
    let writes = 0;
    let timeoutHandler;
    const request = () => {
      requests += 1;
      const req = new EventEmitter();
      req.setTimeout = (_value, handler) => { timeoutHandler = handler; };
      req.write = () => { writes += 1; };
      req.destroy = (error) => req.emit('error', error);
      req.end = () => {
        if (failure === 'timeout') timeoutHandler();
        else req.emit('error', new Error('socket failed'));
      };
      return req;
    };
    await assert.rejects(
      bitbucketRequest({
        auth,
        method: 'POST',
        path: '/2.0/repositories/workspace/repo/pullrequests/7/comments',
        body: { content: { raw: 'review comment' } },
        request,
      }),
      failure === 'timeout' ? /timed out/u : /socket failed/u,
    );
    assert.equal(requests, 1);
    assert.equal(writes, 1);
  });
});

function interruptedBitbucketRequest() {
  let response;
  let requestDestroyed = false;
  const request = (_options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.end = () => {
      response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.complete = false;
      response.destroy = () => { response.destroyed = true; };
      callback(response);
    };
    req.destroy = () => { requestDestroyed = true; };
    return req;
  };
  const promise = bitbucketRequest({ auth, path: '/2.0/user', request });
  return {
    promise,
    response,
    requestWasDestroyed: () => requestDestroyed,
  };
}

test('Bitbucket REST rejects and cleans up a response error after partial data', async () => {
  const interrupted = interruptedBitbucketRequest();
  interrupted.response.emit('data', Buffer.from('{"uuid":'));
  assert.doesNotThrow(() => interrupted.response.emit('error', new Error('socket reset')));
  await assert.rejects(interrupted.promise, /response failed.*socket reset/u);
  assert.equal(interrupted.requestWasDestroyed(), true);
});

test('Bitbucket REST rejects and cleans up an aborted response after partial data', async () => {
  const interrupted = interruptedBitbucketRequest();
  interrupted.response.emit('data', Buffer.from('{"uuid":'));
  interrupted.response.emit('aborted');
  await assert.rejects(interrupted.promise, /response was aborted/u);
  assert.equal(interrupted.requestWasDestroyed(), true);
});

test('Bitbucket discovery filters open repository PRs by stable reviewer UUID', async () => {
  const paths = [];
  const result = await searchBitbucketReviewRequestedPRs({
    account,
    repo: 'Workspace/repo name',
    auth,
    api: async ({ path }) => {
      paths.push(path);
      return {
        values: [
          { id: 7, reviewers: [{ uuid: account.accountId }] },
          { id: 8, reviewers: [{ uuid: '{223e4567-e89b-42d3-a456-426614174000}' }] },
        ],
      };
    },
  });
  assert.deepEqual(result, [{ repo: 'Workspace/repo name', number: 7 }]);
  assert.equal(
    paths[0],
    '/2.0/repositories/Workspace/repo%20name/pullrequests?state=OPEN&pagelen=50',
  );
});

test('Bitbucket PR discovery fails closed instead of truncating at the value limit', async () => {
  let page = 0;
  await assert.rejects(
    searchBitbucketReviewRequestedPRs({
      account,
      repo: 'workspace/repo',
      auth,
      api: async () => {
        page += 1;
        return {
          values: Array.from({ length: 50 }, (_value, index) => ({
            id: ((page - 1) * 50) + index + 1,
            reviewers: [{ uuid: account.accountId }],
          })),
          next: `https://api.bitbucket.org/2.0/repositories/workspace/repo/pullrequests?state=OPEN&pagelen=50&page=${page + 1}`,
        };
      },
    }),
    /pagination exceeded the value limit/u,
  );
  assert.equal(page, 10);
});

test('Bitbucket comment discovery fails closed instead of missing a marker after the value limit', async () => {
  let page = 0;
  await assert.rejects(
    bitbucketReviewAlreadyPosted({
      repo: 'workspace/repo',
      number: 7,
      marker: '<!-- marker -->',
      auth,
      api: async () => {
        page += 1;
        return {
          values: Array.from({ length: 50 }, () => ({
            user: { uuid: account.accountId },
            content: { raw: 'older comment' },
          })),
          next: `https://api.bitbucket.org/2.0/repositories/workspace/repo/pullrequests/7/comments?pagelen=50&page=${page + 1}`,
        };
      },
    }),
    /pagination exceeded the value limit/u,
  );
  assert.equal(page, 10);
});

test('Bitbucket metadata is normalized to the poller PR contract', async () => {
  const pr = await getBitbucketPullRequest({
    repo: 'workspace/repo', number: 7, auth,
    api: async () => ({
      id: 7,
      title: 'Change',
      description: 'Body',
      state: 'OPEN',
      source: { commit: { hash: 'abc' }, branch: { name: 'feature' } },
      destination: { branch: { name: 'main' } },
      links: { html: { href: 'https://bitbucket.org/workspace/repo/pull-requests/7' } },
    }),
  });
  assert.deepEqual(pr, {
    headRefOid: 'abc', number: 7, title: 'Change', body: 'Body', state: 'OPEN',
    headRefName: 'feature', baseRefName: 'main',
    url: 'https://bitbucket.org/workspace/repo/pull-requests/7',
  });
});

test('Bitbucket review preparation demotes invalid inline locations', () => {
  const prepared = prepareBitbucketReview({
    body: 'Summary', marker: '<!-- marker -->', auth,
    diff: '+++ b/src/a.js\n@@ -0,0 +1 @@\n+line\n',
    comments: [
      { path: 'src/a.js', line: 1, severity: 'major', comment: 'Valid' },
      { path: 'src/a.js', line: 99, severity: 'nit', comment: 'Invalid' },
    ],
  });
  assert.equal(prepared.anchorable.length, 1);
  assert.equal(prepared.unanchorable.length, 1);
  assert.match(prepared.summary, /src\/a\.js:99/u);
});

test('Bitbucket summary safely bounds code spans and disables mentions in adversarial paths', () => {
  const marker = '<!-- completion marker -->';
  const adversarialPath = `${'`'.repeat(20)}@reviewers[x](https://attacker.example)`;
  const expansionPath = '`'.repeat(450);
  const prepared = prepareBitbucketReview({
    body: 'Summary', marker, auth, diff: '',
    comments: [
      {
        path: adversarialPath,
        line: 99,
        severity: 'major',
        comment: 'Mention finding',
      },
      {
        path: expansionPath,
        line: 100,
        severity: 'nit',
        comment: 'Expansion finding',
      },
    ],
  });

  const mentionLine = prepared.summary.split('\n').find((line) =>
    line.includes('Mention finding'));
  const expansionLine = prepared.summary.split('\n').find((line) =>
    line.includes('Expansion finding'));
  assert.ok(mentionLine);
  assert.doesNotMatch(mentionLine, /@reviewers/u);
  assert.match(mentionLine, /@\u200Breviewers/u);
  assert.match(mentionLine, /`{21} .*:99 `{21}/u);
  assert.ok(expansionLine);
  assert.ok(expansionLine.length < 700);
  assert.match(expansionLine, /…:100/u);
  assert.equal(prepared.summary.split(marker).length - 1, 1);
});

test('Bitbucket attribution bounds identity and neutralizes Markdown, mentions, and controls', () => {
  const maliciousDisplayName = `${'[ops](https://attacker.example) @reviewers'}\n---\u202E` +
    'x'.repeat(300);
  const prepared = prepareBitbucketReview({
    body: 'Summary',
    marker: '<!-- marker -->',
    auth: { ...auth, displayName: maliciousDisplayName },
    diff: '',
    comments: [],
  });
  const attribution = prepared.summary.split('\n').find((line) =>
    line.includes('OpenMergeLens generated this review'));

  assert.ok(attribution);
  assert.match(
    attribution,
    /on behalf of ` \[ops\]\(https:\/\/attacker\.example\).* `\. Verify/u,
  );
  assert.doesNotMatch(attribution, /@reviewers/u);
  assert.match(attribution, /@\u200Breviewers/u);
  assert.doesNotMatch(attribution, /\u202E|\n---/u);
  assert.ok([...attribution].length < 300);
});

test('Bitbucket posting writes inline comments before the completion marker', async () => {
  const marker = createBitbucketReviewMarker({
    account, repo: 'workspace/repo', number: 7, commitId: 'abc',
  });
  const calls = [];
  const api = async (request) => {
    if (request.method !== 'POST') return { values: [] };
    calls.push(request.body);
    return { id: calls.length };
  };
  await postBitbucketReview({
    repo: 'workspace/repo', number: 7, body: 'Summary', marker, auth, api,
    diff: '+++ b/src/a.js\n@@ -0,0 +1 @@\n+line\n',
    comments: [{ path: 'src/a.js', line: 1, severity: 'major', comment: 'Finding' }],
    scheduleMutation: (operation) => operation(),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].inline, { path: 'src/a.js', to: 1 });
  assert.doesNotMatch(calls[0].content.raw, /openmergelens-review:/u);
  assert.match(calls[1].content.raw, /openmergelens-review:/u);
  assert.equal(await bitbucketReviewAlreadyPosted({
    repo: 'workspace/repo', number: 7, marker, auth,
    api: async () => ({ values: [{ user: { uuid: account.accountId }, content: { raw: marker } }] }),
  }), true);
});

test('Bitbucket posting demotes a provider-rejected inline location into the summary', async () => {
  const marker = createBitbucketReviewMarker({
    account, repo: 'workspace/repo', number: 7, commitId: 'abc',
  });
  const posted = [];
  await postBitbucketReview({
    repo: 'workspace/repo', number: 7, body: 'Summary', marker, auth,
    diff: '+++ b/src/a.js\n@@ -0,0 +1 @@\n+line\n',
    comments: [{ path: 'src/a.js', line: 1, severity: 'major', comment: 'Finding' }],
    api: async (request) => {
      if (request.method !== 'POST') return { values: [] };
      if (request.body.inline) {
        const error = new Error('invalid inline');
        error.status = 400;
        throw error;
      }
      posted.push(request.body.content.raw);
      return { id: 2 };
    },
    scheduleMutation: (operation) => operation(),
  });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /src\/a\.js:1/u);
  assert.match(posted[0], /openmergelens-review:/u);
});

test('Bitbucket posting resumes an immutable prepared plan without duplicates', async () => {
  const marker = createBitbucketReviewMarker({
    account, repo: 'workspace/repo', number: 7, commitId: 'abc',
  });
  const first = { path: 'src/a.js', line: 1, severity: 'major', comment: 'First finding' };
  const second = { path: 'src/b.js', line: 1, severity: 'nit', comment: 'Second finding' };
  const diff = [
    '+++ b/src/a.js',
    '@@ -0,0 +1 @@',
    '+a',
    '+++ b/src/b.js',
    '@@ -0,0 +1 @@',
    '+b',
    '',
  ].join('\n');
  const stored = [];
  let failSecondFinding = true;
  const api = async (request) => {
    if (request.method !== 'POST') return { values: stored };
    const raw = request.body.content.raw;
    if (request.body.inline && raw.includes('Second finding') && failSecondFinding) {
      failSecondFinding = false;
      throw new Error('temporary transport failure');
    }
    stored.push({
      user: { uuid: account.accountId },
      content: { raw },
      inline: request.body.inline,
    });
    return { id: stored.length };
  };

  await assert.rejects(
    postBitbucketReview({
      repo: 'workspace/repo', number: 7, body: 'Summary', marker, auth, api, diff,
      comments: [first, second],
      scheduleMutation: (operation) => operation(),
    }),
    /temporary transport failure/u,
  );
  await postBitbucketReview({
    repo: 'workspace/repo', number: 7, body: 'Summary', marker, auth, api, diff,
    comments: [first, second],
    scheduleMutation: (operation) => operation(),
  });

  const inlineComments = stored.filter((comment) => comment.inline);
  assert.equal(inlineComments.filter((comment) => comment.content.raw.includes('First finding')).length, 1);
  assert.equal(inlineComments.filter((comment) => comment.content.raw.includes('Second finding')).length, 1);
  assert.equal(stored.filter((comment) => comment.content.raw.includes(marker)).length, 1);
  assert.equal(await bitbucketReviewAlreadyPosted({
    repo: 'workspace/repo', number: 7, marker, auth, api,
  }), true);
});

test('Bitbucket summary 429 rethrows without an out-of-queue reconciliation GET', async () => {
  const marker = createBitbucketReviewMarker({
    account, repo: 'workspace/repo', number: 7, commitId: 'abc',
  });
  let reads = 0;
  await assert.rejects(
    postBitbucketReview({
      repo: 'workspace/repo', number: 7, body: 'Summary', marker, auth,
      diff: '+++ b/src/a.js\n@@ -0,0 +1 @@\n+line\n',
      comments: [],
      api: async (request) => {
        if (request.method !== 'POST') {
          reads += 1;
          return { values: [] };
        }
        const error = new Error('rate limited');
        error.status = 429;
        error.retryAfterMs = 60_000;
        throw error;
      },
      scheduleMutation: (operation) => operation(),
    }),
    (error) => error.status === 429,
  );
  assert.equal(reads, 1);
});

test('Bitbucket initial reconciliation 429 delays the next review reconciliation', async () => {
  let clock = 20_000;
  let releaseSleep;
  const events = [];
  const queue = createGitHubMutationQueue({
    minIntervalMs: 0,
    now: () => clock,
    sleep: (milliseconds) => new Promise((resolve) => {
      events.push(`sleep:${milliseconds}`);
      releaseSleep = () => {
        clock += milliseconds;
        resolve();
      };
    }),
  });
  let reads = 0;
  const api = async (request) => {
    if (request.method === 'POST') {
      events.push('POST');
      return { id: 1 };
    }
    reads += 1;
    events.push(`GET:${reads}`);
    if (reads === 1) {
      throw Object.assign(new Error('rate limited'), {
        status: 429,
        retryAfterMs: 5_000,
      });
    }
    return { values: [] };
  };
  const reviewOptions = (number) => ({
    repo: 'workspace/repo',
    number,
    body: 'Summary',
    marker: createBitbucketReviewMarker({
      account, repo: 'workspace/repo', number, commitId: `commit-${number}`,
    }),
    auth,
    api,
    diff: '',
    comments: [],
    scheduleMutation: (operation) => queue.run(operation),
  });

  await assert.rejects(
    postBitbucketReview(reviewOptions(7)),
    (error) => error.status === 429,
  );
  const secondReview = postBitbucketReview(reviewOptions(8));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['GET:1', 'sleep:5000']);
  assert.equal(reads, 1);
  releaseSleep();
  await secondReview;
  assert.deepEqual(events, ['GET:1', 'sleep:5000', 'GET:2', 'POST']);
});

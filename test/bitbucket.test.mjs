import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  getBitbucketPullRequestDiff,
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
      if (path === '/2.0/user/workspaces?pagelen=50') {
        return { values: [
          { workspace: { slug: 'Workspace' } },
          { workspace: { slug: 'workspace' } },
        ] };
      }
      return { values: [{ full_name: 'Workspace/Repo', is_private: true }] };
    },
  });
  assert.deepEqual(calls, [
    '/2.0/user/workspaces?pagelen=50',
    '/2.0/repositories/Workspace?role=member&pagelen=50&sort=full_name',
  ]);
  assert.deepEqual(repos, [{ nameWithOwner: 'Workspace/Repo', isPrivate: true }]);
  assert.equal(calls.some((path) => path.startsWith('/2.0/repositories?')), false);
});

test('Bitbucket repository discovery rejects malformed metadata', async () => {
  await assert.rejects(
    listAccessibleBitbucketRepos({
      auth,
      api: async ({ path }) => path.includes('user/workspaces')
        ? { values: [{ workspace: { slug: 'Workspace' } }] }
        : { values: [{ full_name: 'missing-slash' }] },
    }),
    /repository response is malformed/u,
  );
});

test('Bitbucket repository discovery rejects malformed, foreign, and conflicting results', async (t) => {
  for (const [name, repositories, pattern] of [
    ['foreign owner', [{ full_name: 'Other/Repo', is_private: true }], /foreign/u],
    ['conflicting duplicate', [
      { full_name: 'Workspace/Repo', is_private: true },
      { full_name: 'workspace/repo', is_private: true },
    ], /conflicting/u],
  ]) await t.test(name, async () => {
    await assert.rejects(listAccessibleBitbucketRepos({
      auth,
      api: async ({ path }) => path.includes('user/workspaces')
        ? { values: [{ workspace: { slug: 'Workspace' } }] }
        : { values: repositories },
    }), pattern);
  });
  await assert.rejects(listAccessibleBitbucketRepos({
    auth,
    api: async () => ({ values: [{ workspace: { slug: ' workspace ' } }] }),
  }), /workspace response is malformed/u);
});

test('Bitbucket workspace and repository discovery enforce collection caps', async (t) => {
  await t.test('workspace value cap', async () => {
    await assert.rejects(listAccessibleBitbucketRepos({
      auth,
      api: async () => ({
        values: Array.from({ length: 101 }, (_, index) => ({
          workspace: { slug: `workspace${index}` },
        })),
      }),
    }), (error) => error.cause?.message === 'Bitbucket API pagination exceeded the value limit');
  });
  await t.test('repository value cap', async () => {
    await assert.rejects(listAccessibleBitbucketRepos({
      auth,
      api: async ({ path }) => path.includes('user/workspaces')
        ? { values: [{ workspace: { slug: 'Workspace' } }] }
        : {
          values: Array.from({ length: 501 }, (_, index) => ({
            full_name: `Workspace/repo${index}`,
            is_private: true,
          })),
        },
    }), (error) => error.cause?.message === 'Bitbucket API pagination exceeded the value limit');
  });
  await t.test('ten-page collection cap', async () => {
    let page = 0;
    await assert.rejects(listAccessibleBitbucketRepos({
      auth,
      api: async ({ path }) => {
        page += 1;
        return { values: [], next: `https://api.bitbucket.org/2.0/user/workspaces?page=${page + 1}` };
      },
    }), (error) => error.cause?.message === 'Bitbucket API pagination exceeded the page limit');
    assert.equal(page, 10);
  });
});

test('Bitbucket discovery enforces one aggregate page budget across workspaces', async () => {
  let calls = 0;
  await assert.rejects(listAccessibleBitbucketRepos({
    auth,
    api: async ({ path }) => {
      calls += 1;
      if (path.includes('user/workspaces')) {
        return {
          values: Array.from({ length: 100 }, (_, index) => ({
            workspace: { slug: `workspace${String(index).padStart(3, '0')}` },
          })),
        };
      }
      const url = new URL(`https://api.bitbucket.org${path}`);
      return url.searchParams.has('page')
        ? { values: [] }
        : { values: [], next: `https://api.bitbucket.org${url.pathname}?page=2` };
    },
  }), (error) => error.cause?.message ===
    'Bitbucket repository discovery exceeded the aggregate page limit' &&
    /repository discovery failed for workspace.*aggregate page limit exceeded/u.test(error.message));
  assert.equal(calls, 112);
});

test('Bitbucket discovery exposes bounded safe operational failure details', async (t) => {
  await t.test('timeout', async () => {
    const cause = new Error('Bitbucket API request timed out');
    await assert.rejects(listAccessibleBitbucketRepos({
      auth,
      api: async () => { throw cause; },
    }), (error) => error.cause === cause &&
      error.message === 'Bitbucket workspace discovery failed: request timed out');
  });
  await t.test('unsafe repository pagination', async () => {
    await assert.rejects(listAccessibleBitbucketRepos({
      auth,
      api: async ({ path }) => path.includes('user/workspaces')
        ? { values: [{ workspace: { slug: 'Workspace' } }] }
        : {
          values: [],
          next: 'https://attacker.example/2.0/repositories/Workspace?page=2',
        },
    }), (error) => error.message ===
      'Bitbucket repository discovery failed for workspace "Workspace": unsafe pagination URL');
  });
  for (const [name, code, detail] of [
    ['DNS', 'ENOTFOUND', 'DNS lookup failed (ENOTFOUND)'],
    ['socket', 'ECONNRESET', 'network request failed (ECONNRESET)'],
  ]) await t.test(name, async () => {
    const cause = Object.assign(new Error('untrusted transport diagnostics'), { code });
    await assert.rejects(listAccessibleBitbucketRepos({
      auth,
      api: async () => { throw cause; },
    }), (error) => error.cause === cause && error.message.endsWith(detail) &&
      !error.message.includes('untrusted transport diagnostics'));
  });
  await t.test('ordinary HTTP status', async () => {
    const cause = Object.assign(new Error('provider body must not render'), { status: 500 });
    await assert.rejects(listAccessibleBitbucketRepos({
      auth,
      api: async () => { throw cause; },
    }), (error) => error.status === 500 && error.cause === cause &&
      error.message === 'Bitbucket workspace discovery failed: HTTP 500');
  });
  await t.test('arbitrary provider error', async () => {
    const secret = 'Bearer fixture-secret-shaped-value';
    const cause = new Error(`${secret}\n${'x'.repeat(2_000)}`);
    await assert.rejects(listAccessibleBitbucketRepos({
      auth,
      api: async () => { throw cause; },
    }), (error) => error.cause === cause &&
      error.message === 'Bitbucket workspace discovery failed: unexpected provider error' &&
      !error.message.includes(secret) && !/[\r\n]/u.test(error.message) &&
      error.message.length < 100);
  });
});

test('Bitbucket discovery reports scope and stale-workspace status without response data', async (t) => {
  const statusError = (status) => Object.assign(new Error('raw provider response'), { status });
  await t.test('workspace 403', async () => {
    await assert.rejects(listAccessibleBitbucketRepos({
      auth,
      api: async () => { throw statusError(403); },
    }), (error) => error.status === 403 && error.cause?.status === 403 &&
      /read:workspace:bitbucket.*recreate/u.test(error.message) &&
      !error.message.includes('raw provider response'));
  });
  for (const status of [403, 404, 410]) await t.test(`repository ${status}`, async () => {
    await assert.rejects(listAccessibleBitbucketRepos({
      auth,
      api: async ({ path }) => {
        if (path.includes('user/workspaces')) {
          return { values: [{ workspace: { slug: 'Workspace' } }] };
        }
        throw statusError(status);
      },
    }), (error) => error.status === status && error.cause?.status === status &&
      (status === 403
        ? /Workspace.*read:repository:bitbucket/u.test(error.message)
        : /Workspace.*configuration was not changed/u.test(error.message)) &&
      !error.message.includes('raw provider response'));
  });
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
  assert.throws(() => bitbucketRequest({
    auth,
    method: 'POST',
    path: '/2.0/repositories/workspace/repo/pullrequests/7/comments',
    body,
    redirect: () => '/2.0/user',
    request,
  }), /redirect policy is invalid/u);
});

test('Bitbucket pull request diff follows one validated provider redirect', async () => {
  const calls = [];
  const location = 'https://api.bitbucket.org/2.0/repositories/workspace/repo/' +
    'diff/workspace/repo:abc%0Ddef?from_pullrequest_id=7&topic=true';
  const request = (options, callback) => {
    calls.push(options);
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = calls.length === 1 ? 302 : 200;
      response.headers = calls.length === 1 ? { location } : {};
      callback(response);
      response.end(calls.length === 1 ? '' : 'diff body');
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
  const api = (options) => bitbucketRequest({ ...options, request });

  assert.equal(await getBitbucketPullRequestDiff({
    repo: 'workspace/repo', number: 7, auth, api,
  }), 'diff body');
  assert.deepEqual(calls.map((call) => call.path), [
    '/2.0/repositories/workspace/repo/pullrequests/7/diff',
    '/2.0/repositories/workspace/repo/diff/workspace/repo:abc%0Ddef' +
      '?from_pullrequest_id=7&topic=true',
  ]);
  assert.equal(calls.every((call) => call.method === 'GET'), true);
  assert.equal(calls.every((call) => call.hostname === 'api.bitbucket.org'), true);
  assert.equal(calls.every((call) => call.headers.accept === 'text/plain'), true);
  assert.equal(calls[1].headers.authorization, calls[0].headers.authorization);
});

test('Bitbucket pull request diff rejects unsafe or repeated redirects', async (t) => {
  const validPath = '/2.0/repositories/workspace/repo/' +
    'diff/workspace/repo:abc%0Ddef?from_pullrequest_id=7&topic=true';
  const unsafeLocations = [
    undefined,
    `https://attacker.example${validPath}`,
    `http://api.bitbucket.org${validPath}`,
    `https://user@example.com${validPath}`,
    `https://api.bitbucket.org:444${validPath}`,
    `https://api.bitbucket.org${validPath}#fragment`,
    `https://api.bitbucket.org${validPath.replace('/workspace/repo/diff/', '/other/repo/diff/')}`,
    `https://api.bitbucket.org${validPath.replace('from_pullrequest_id=7', 'from_pullrequest_id=8')}`,
    `https://api.bitbucket.org${validPath}&extra=true`,
    `https://api.bitbucket.org${validPath.replace('abc%0Ddef', 'abc%2Fdef')}`,
    validPath,
  ];
  for (const [index, location] of unsafeLocations.entries()) await t.test(String(index), async () => {
    let calls = 0;
    const request = (_options, callback) => {
      calls += 1;
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.end = () => {
        const response = new PassThrough();
        response.statusCode = 302;
        response.headers = location === undefined ? {} : { location };
        callback(response);
        response.end();
      };
      req.destroy = (error) => req.emit('error', error);
      return req;
    };
    const api = (options) => bitbucketRequest({ ...options, request });
    await assert.rejects(getBitbucketPullRequestDiff({
      repo: 'workspace/repo', number: 7, auth, api,
    }), /unsafe redirect|HTTP 302/u);
    assert.equal(calls, 1);
  });

  let calls = 0;
  const request = (_options, callback) => {
    calls += 1;
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {
      const response = new PassThrough();
      response.statusCode = 302;
      response.headers = {
        location: `https://api.bitbucket.org${validPath}`,
      };
      callback(response);
      response.end();
    };
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
  const api = (options) => bitbucketRequest({ ...options, request });
  await assert.rejects(getBitbucketPullRequestDiff({
    repo: 'workspace/repo', number: 7, auth, api,
  }), /HTTP 302/u);
  assert.equal(calls, 2);
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
          { id: 9 },
        ],
      };
    },
  });
  assert.deepEqual(result, [{ repo: 'Workspace/repo name', number: 7 }]);
  assert.equal(
    paths[0],
    '/2.0/repositories/Workspace/repo%20name/pullrequests?' +
      'state=OPEN&pagelen=50&fields=%2Bvalues.reviewers',
  );
});

test('Bitbucket discovery returns a requested PR from a later collection page', async () => {
  const firstPath = '/2.0/repositories/workspace/repo/pullrequests?' +
    'state=OPEN&pagelen=50&fields=%2Bvalues.reviewers';
  const secondPath = `${firstPath}&page=2`;
  const paths = [];
  const result = await searchBitbucketReviewRequestedPRs({
    account,
    repo: 'workspace/repo',
    auth,
    api: async ({ path }) => {
      paths.push(path);
      if (path === firstPath) {
        return {
          values: [{
            id: 7,
            reviewers: [{ uuid: '{223e4567-e89b-42d3-a456-426614174000}' }],
          }],
          next: `https://api.bitbucket.org${secondPath}`,
        };
      }
      if (path === secondPath) {
        return {
          values: [{ id: 8, reviewers: [{ uuid: account.accountId }] }],
        };
      }
      throw new Error(`unexpected Bitbucket API path: ${path}`);
    },
  });
  assert.deepEqual(paths, [firstPath, secondPath]);
  assert.deepEqual(result, [{ repo: 'workspace/repo', number: 8 }]);
});

test('Bitbucket PR discovery fails closed instead of truncating at the value limit', async () => {
  let page = 0;
  const paths = [];
  await assert.rejects(
    searchBitbucketReviewRequestedPRs({
      account,
      repo: 'workspace/repo',
      auth,
      api: async ({ path }) => {
        paths.push(path);
        page += 1;
        return {
          values: Array.from({ length: 50 }, (_value, index) => ({
            id: ((page - 1) * 50) + index + 1,
            reviewers: [{ uuid: account.accountId }],
          })),
          next: 'https://api.bitbucket.org/2.0/repositories/workspace/repo/pullrequests?' +
            `state=OPEN&pagelen=50&fields=%2Bvalues.reviewers&page=${page + 1}`,
        };
      },
    }),
    /pagination exceeded the value limit/u,
  );
  assert.equal(page, 10);
  assert.equal(
    paths[0],
    '/2.0/repositories/workspace/repo/pullrequests?' +
      'state=OPEN&pagelen=50&fields=%2Bvalues.reviewers',
  );
  assert.equal(
    paths[1],
    '/2.0/repositories/workspace/repo/pullrequests?' +
      'state=OPEN&pagelen=50&fields=%2Bvalues.reviewers&page=2',
  );
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

test('Bitbucket review markers use Markdown reference definitions and recognize legacy HTML', async () => {
  const marker = createBitbucketReviewMarker({
    account, repo: 'workspace/repo', number: 7, commitId: 'abc',
  });
  assert.match(marker, /^\[openmergelens-review-[a-f0-9]{64}\]: #$/u);
  assert.doesNotMatch(marker, /[<>]/u);
  const digest = /^\[openmergelens-review-([a-f0-9]{64})\]: #$/u.exec(marker)[1];
  const legacyMarker = `<!-- openmergelens-review:${digest} -->`;
  assert.equal(await bitbucketReviewAlreadyPosted({
    repo: 'workspace/repo', number: 7, marker, auth,
    api: async () => ({
      values: [{
        user: { uuid: account.accountId },
        content: { raw: `Legacy review\n\n${legacyMarker}` },
      }],
    }),
  }), true);
});

test('Bitbucket review preparation demotes invalid inline locations', () => {
  const prepared = prepareBitbucketReview({
    body: 'Summary', marker: '<!-- marker -->', auth,
    includeAttribution: false,
    diff: '+++ b/src/a.js\n@@ -0,0 +1 @@\n+line\n',
    comments: [
      { path: 'src/a.js', line: 1, severity: 'major', comment: 'Valid' },
      { path: 'src/a.js', line: 99, severity: 'nit', comment: 'Invalid' },
    ],
  });
  assert.equal(prepared.anchorable.length, 1);
  assert.equal(prepared.unanchorable.length, 1);
  assert.match(prepared.summary, /src\/a\.js:99/u);
  assert.doesNotMatch(prepared.summary, /OpenMergeLens generated this review/u);
  assert.match(prepared.summary, /<!-- marker -->/u);
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
    includeAttribution: true,
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
    includeAttribution: false,
    diff: '+++ b/src/a.js\n@@ -0,0 +1 @@\n+line\n',
    comments: [{ path: 'src/a.js', line: 1, severity: 'major', comment: 'Finding' }],
    scheduleMutation: (operation) => operation(),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].inline, { path: 'src/a.js', to: 1 });
  assert.match(calls[0].content.raw, /\[openmergelens-finding-[a-f0-9]{64}\]: #$/u);
  assert.doesNotMatch(calls[0].content.raw, /<!--/u);
  assert.match(calls[1].content.raw, /\[openmergelens-review-[a-f0-9]{64}\]: #$/u);
  assert.doesNotMatch(calls[1].content.raw, /<!--/u);
  assert.doesNotMatch(calls[1].content.raw, /OpenMergeLens generated this review/u);
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
  assert.match(posted[0], /\[openmergelens-review-[a-f0-9]{64}\]: #$/u);
});

test('Bitbucket posting recognizes legacy partial inline markers without duplicating findings', async () => {
  const marker = createBitbucketReviewMarker({
    account, repo: 'workspace/repo', number: 7, commitId: 'abc',
  });
  const reviewDigest = /^\[openmergelens-review-([a-f0-9]{64})\]: #$/u.exec(marker)[1];
  const legacyReviewMarker = `<!-- openmergelens-review:${reviewDigest} -->`;
  const finding = {
    path: 'src/a.js', line: 1, severity: 'major', comment: 'Existing finding',
  };
  const legacyFindingIdentity = JSON.stringify([
    legacyReviewMarker, 0, finding.path, finding.line,
  ]);
  const legacyFindingDigest = createHash('sha256')
    .update(legacyFindingIdentity)
    .digest('hex');
  const legacyFindingMarker = `<!-- openmergelens-finding:${legacyFindingDigest} -->`;
  const posts = [];
  await postBitbucketReview({
    repo: 'workspace/repo', number: 7, body: 'Summary', marker, auth,
    diff: '+++ b/src/a.js\n@@ -0,0 +1 @@\n+line\n',
    comments: [finding],
    api: async (request) => {
      if (request.method === 'POST') {
        posts.push(request.body);
        return { id: 2 };
      }
      return {
        values: [{
          user: { uuid: account.accountId },
          content: { raw: `**[major]** Existing finding\n\n${legacyFindingMarker}` },
          inline: { path: finding.path, to: finding.line },
        }],
      };
    },
    scheduleMutation: (operation) => operation(),
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].inline, undefined);
  assert.match(posts[0].content.raw, /\[openmergelens-review-[a-f0-9]{64}\]: #$/u);
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

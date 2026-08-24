import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  discoverBitbucketAccount,
  normalizeBitbucketCredentialUsername,
  resolveBitbucketAuth,
  __test,
} from '../lib/bitbucket-auth.mjs';

const account = {
  accountId: '{123e4567-e89b-42d3-a456-426614174000}',
  credentialUsername: 'reviewer@example.com',
};

test('Bitbucket credentials are requested noninteractively and verified by UUID', async () => {
  let request;
  const auth = await resolveBitbucketAuth(account, {
    credentialFill: async (value) => {
      request = value;
      return 'protocol=https\nhost=bitbucket.org\nusername=reviewer@example.com\npassword=secret-value\n';
    },
    requestUser: async ({ auth: supplied }) => {
      assert.equal(supplied.password, 'secret-value');
      return { uuid: account.accountId, display_name: 'Reviewer' };
    },
  });
  assert.equal(
    request.input,
    'protocol=https\nhost=bitbucket.org\nusername=reviewer@example.com\n\n',
  );
  assert.equal(auth.accountId, account.accountId);
  assert.equal(auth.displayName, 'Reviewer');
});

test('Bitbucket credential identity mismatch fails closed without exposing the token', async () => {
  await assert.rejects(
    resolveBitbucketAuth(account, {
      credentialFill: async () =>
        'username=reviewer@example.com\npassword=do-not-expose\n',
      requestUser: async () => ({ uuid: '{223e4567-e89b-42d3-a456-426614174000}' }),
    }),
    (error) => {
      assert.doesNotMatch(error.message, /do-not-expose/u);
      return /different account UUID/u.test(error.message);
    },
  );
});

test('credential parser rejects a mismatched username', () => {
  assert.throws(
    () => __test.parseCredential('username=other\npassword=secret\n', account.credentialUsername),
    /unusable/u,
  );
});

test('Bitbucket account discovery derives the stable UUID without persisting credentials', async () => {
  const discovered = await discoverBitbucketAccount(' reviewer@example.com ', {
    credentialFill: async ({ input }) => {
      assert.equal(input, 'protocol=https\nhost=bitbucket.org\nusername=reviewer@example.com\n\n');
      return 'username=reviewer@example.com\npassword=secret-value\n';
    },
    requestUser: async ({ auth }) => {
      assert.equal(auth.password, 'secret-value');
      return { uuid: account.accountId.toUpperCase(), display_name: 'Reviewer' };
    },
  });
  assert.deepEqual(discovered.account, {
    hostname: 'bitbucket.org',
    accountId: account.accountId,
    credentialUsername: account.credentialUsername,
  });
  assert.equal('password' in discovered.account, false);
});

test('Bitbucket username and identity validation fail before unsafe credential use', async () => {
  for (const unsafe of [
    'reviewer\npassword=injected',
    'reviewer\u001b[31m@example.com',
    'reviewer\u202e@example.com',
    'reviewer\u200b@example.com',
  ]) {
    assert.throws(() => normalizeBitbucketCredentialUsername(unsafe), /invalid/u);
  }
  let credentialCalls = 0;
  await assert.rejects(
    discoverBitbucketAccount('reviewer\npassword=injected', {
      credentialFill: async () => { credentialCalls += 1; },
      requestUser: async () => ({ uuid: account.accountId }),
    }),
    /invalid/u,
  );
  assert.equal(credentialCalls, 0);

  await assert.rejects(
    discoverBitbucketAccount(account.credentialUsername, {
      credentialFill: async () => 'username=reviewer@example.com\npassword=hidden\n',
      requestUser: async () => ({ uuid: 'not-a-uuid', raw: 'hidden' }),
    }),
    (error) => {
      assert.match(error.message, /valid account UUID/u);
      assert.doesNotMatch(error.message, /hidden/u);
      return true;
    },
  );
});

test('credential lookup handles an early stdin EPIPE once and kills the helper', async () => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.stdin.end = () => {
    const error = Object.assign(new Error('broken pipe secret must stay hidden'), {
      code: 'EPIPE',
    });
    child.stdin.emit('error', error);
    child.emit('close', 1);
    assert.doesNotThrow(() => child.stdin.emit('error', error));
  };

  await assert.rejects(
    __test.runCredentialFill({
      input: 'protocol=https\nhost=bitbucket.org\n\n',
      spawnProcess: () => child,
    }),
    (error) => {
      assert.match(error.message, /could not send request/u);
      assert.doesNotMatch(error.message, /secret/u);
      return true;
    },
  );
  assert.equal(child.killed, true);
});

test('credential lookup handles early and late stdout/stderr errors with one kill', async () => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  let kills = 0;
  child.kill = () => {
    kills += 1;
    child.killed = true;
    return true;
  };
  child.stdin.end = () => {
    child.stdout.emit('error', new Error('stdout secret must stay hidden'));
    child.stderr.emit('error', new Error('stderr secret must stay hidden'));
    child.emit('close', 1);
  };

  await assert.rejects(
    __test.runCredentialFill({
      input: 'protocol=https\nhost=bitbucket.org\n\n',
      spawnProcess: () => child,
    }),
    (error) => {
      assert.match(error.message, /could not read response/u);
      assert.doesNotMatch(error.message, /secret/u);
      return true;
    },
  );
  assert.doesNotThrow(() => child.stdout.emit('error', new Error('late stdout')));
  assert.doesNotThrow(() => child.stderr.emit('error', new Error('late stderr')));
  assert.equal(kills, 1);
});

test('credential lookup keeps stream error handlers after successful settlement', async () => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  let kills = 0;
  child.kill = () => {
    kills += 1;
    child.killed = true;
    return true;
  };
  child.stdin.end = () => {
    child.stdout.emit(
      'data',
      Buffer.from('username=reviewer@example.com\npassword=secret\n'),
    );
    child.emit('close', 0);
  };

  const output = await __test.runCredentialFill({
    input: 'protocol=https\nhost=bitbucket.org\n\n',
    spawnProcess: () => child,
  });
  assert.match(output, /password=secret/u);
  assert.doesNotThrow(() => child.stdout.emit('error', new Error('late stdout')));
  assert.doesNotThrow(() => child.stderr.emit('error', new Error('late stderr')));
  assert.equal(kills, 0);
});

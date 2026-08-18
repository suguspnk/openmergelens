import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHome, environmentWithTestHome } from './test-home.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('fatal poll startup errors are persisted to poll.log', async (t) => {
  const userHome = await createTestHome(t, 'openmergelens-bin-poll-');

  await assert.rejects(
    execFileAsync(process.execPath, ['bin/poll.mjs', '--invalid'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...environmentWithTestHome(process.env, userHome),
        OPENMERGELENS_DESKTOP_NOTIFICATIONS: '0',
      },
    }),
  );

  const log = await readFile(path.join(userHome, 'poll.log'), 'utf8');
  const record = JSON.parse(log.trim());
  assert.equal(record.level, 'fatal');
  assert.equal(record.event, 'startup.failure');
  assert.equal(record.scope, 'fatal');
  assert.match(record.message, /openmergelens: unrecognized argument "--invalid"/);
});

test('public CLI parse errors are persisted as one structured startup failure', async (t) => {
  const userHome = await createTestHome(t, 'openmergelens-bin-entrypoint-');

  await assert.rejects(
    execFileAsync(process.execPath, ['bin/openmergelens.mjs', '--invalid'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...environmentWithTestHome(process.env, userHome),
      },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /openmergelens: unrecognized argument "--invalid"/);
      return true;
    },
  );

  const contents = await readFile(path.join(userHome, 'poll.log'), 'utf8');
  const records = contents.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'fatal');
  assert.equal(records[0].event, 'startup.failure');
  assert.equal(records[0].scope, 'fatal');
  assert.match(records[0].message, /openmergelens: unrecognized argument "--invalid"/);
});

test('public CLI parse errors release the log coordination marker', async (t) => {
  const userHome = await createTestHome(t, 'openmergelens-bin-entrypoint-lock-');

  await assert.rejects(
    execFileAsync(process.execPath, ['bin/openmergelens.mjs', '--bad'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...environmentWithTestHome(process.env, userHome),
      },
    }),
    (error) => {
      assert.equal(error.code, 1);
      return true;
    },
  );

  assert.deepEqual(await readdir(userHome), ['poll.log']);
});

test('public CLI parse errors redact token-shaped arguments on stderr', async (t) => {
  const userHome = await createTestHome(t, 'openmergelens-bin-entrypoint-secret-');
  const token = 'ghp_TOKEN_SHAPED_INVALID_VALUE_1234567890';

  await assert.rejects(
    execFileAsync(process.execPath, ['bin/openmergelens.mjs', token], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...environmentWithTestHome(process.env, userHome),
      },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /openmergelens: unrecognized argument "\[REDACTED\]"/);
      assert.doesNotMatch(error.stderr, new RegExp(token));
      return true;
    },
  );

  const contents = await readFile(path.join(userHome, 'poll.log'), 'utf8');
  const records = contents.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].event, 'startup.failure');
  assert.doesNotMatch(contents, new RegExp(token));
});

test('public CLI parse errors bound oversized arguments on stderr', async (t) => {
  const invalidArgument = 'invalid-argument-'.repeat(1_000);
  const userHome = await createTestHome(t, 'openmergelens-bin-entrypoint-bound-');

  await assert.rejects(
    execFileAsync(process.execPath, ['bin/openmergelens.mjs', invalidArgument], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...environmentWithTestHome(process.env, userHome),
      },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /… \[truncated\]/);
      assert.ok(error.stderr.length < invalidArgument.length);
      return true;
    },
  );
});

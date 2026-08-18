import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyScheduledEnvironment,
  readScheduledEnvironment,
} from '../lib/scheduled-environment.mjs';
import { createTestHome, environmentWithTestHome } from './test-home.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('FINDING-FRESH-002 scheduled environment restores GitHub CLI config and session keys', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-scheduled-env-'));
  const filePath = path.join(directory, 'scheduler-environment.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(filePath, JSON.stringify({
    PATH: '/custom/bin',
    HOME: '/home/reviewer',
    CODEX_HOME: '/home/reviewer/.codex',
    CLAUDE_CONFIG_DIR: '/home/reviewer/.claude',
    GH_CONFIG_DIR: '/home/reviewer/.config/gh',
    OPENMERGELENS_HOME: '/custom/state',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XDG_RUNTIME_DIR: '/run/user/1000',
  }));

  const target = { UNRELATED: 'preserved' };
  applyScheduledEnvironment(await readScheduledEnvironment(filePath), target);

  assert.deepEqual(target, {
    PATH: '/custom/bin',
    HOME: '/home/reviewer',
    CODEX_HOME: '/home/reviewer/.codex',
    CLAUDE_CONFIG_DIR: '/home/reviewer/.claude',
    GH_CONFIG_DIR: '/home/reviewer/.config/gh',
    OPENMERGELENS_HOME: '/custom/state',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XDG_RUNTIME_DIR: '/run/user/1000',
    UNRELATED: 'preserved',
  });
});

test('scheduled environment rejects extra keys and non-string values', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-scheduled-env-'));
  const filePath = path.join(directory, 'scheduler-environment.json');
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(filePath, JSON.stringify({ NODE_OPTIONS: '--require bad.js' }));
  await assert.rejects(readScheduledEnvironment(filePath), /invalid.*NODE_OPTIONS/);

  await writeFile(filePath, JSON.stringify({ GH_TOKEN: 'do-not-persist' }));
  await assert.rejects(readScheduledEnvironment(filePath), /invalid.*GH_TOKEN/);

  await writeFile(filePath, JSON.stringify({ PATH: 42 }));
  await assert.rejects(readScheduledEnvironment(filePath), /invalid.*PATH/);
});

test('scheduled runner logs missing environment startup failures beside the environment file', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-scheduled-missing-'));
  const environmentPath = path.join(directory, 'scheduler-environment.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const userHome = await createTestHome(t, 'openmergelens-scheduled-process-');

  await assert.rejects(
    execFileAsync(process.execPath, ['bin/scheduled.mjs', environmentPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...environmentWithTestHome(process.env, userHome),
      },
    }),
    (err) => {
      assert.equal(err.code, 1);
      assert.equal(err.stderr, '');
      return true;
    },
  );

  const log = await readFile(path.join(directory, 'poll.log'), 'utf8');
  const record = JSON.parse(log.trim());
  assert.equal(record.level, 'fatal');
  assert.equal(record.event, 'startup.failure');
  assert.match(record.message, /openmergelens: ENOENT: no such file or directory/);
  assert.doesNotMatch(record.message, /at async/);
});

test('scheduled runner logs malformed environment startup failures beside the environment file', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-scheduled-malformed-'));
  const environmentPath = path.join(directory, 'scheduler-environment.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const userHome = await createTestHome(t, 'openmergelens-scheduled-process-');
  await writeFile(environmentPath, '{"PATH":', 'utf8');

  await assert.rejects(
    execFileAsync(process.execPath, ['bin/scheduled.mjs', environmentPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...environmentWithTestHome(process.env, userHome),
      },
    }),
    (err) => {
      assert.equal(err.code, 1);
      assert.equal(err.stderr, '');
      return true;
    },
  );

  const log = await readFile(path.join(directory, 'poll.log'), 'utf8');
  const record = JSON.parse(log.trim());
  assert.equal(record.level, 'fatal');
  assert.equal(record.event, 'startup.failure');
  assert.match(record.message, /openmergelens: .*JSON/);
  assert.doesNotMatch(record.message, /at async/);
});

test('scheduled runner consumes its environment argument before poll argument parsing', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-scheduled-runner-'));
  const environmentPath = path.join(directory, 'scheduler-environment.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const userHome = await createTestHome(t, 'openmergelens-scheduled-process-');
  await writeFile(environmentPath, JSON.stringify({
    PATH: process.env.PATH,
    OPENMERGELENS_HOME: userHome,
  }));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['bin/scheduled.mjs', environmentPath, '--invalid'],
      {
        cwd: projectRoot,
        env: {
          ...environmentWithTestHome(process.env, userHome),
          PATH: '/usr/bin:/bin',
          OPENMERGELENS_DESKTOP_NOTIFICATIONS: '0',
        },
      },
    ),
    (err) => {
      assert.equal(err.stderr, '');
      return true;
    },
  );
  const record = JSON.parse(await readFile(path.join(userHome, 'poll.log'), 'utf8'));
  assert.match(record.message, /unrecognized argument "--invalid"/);
  assert.doesNotMatch(record.message, new RegExp(
    environmentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ));
});

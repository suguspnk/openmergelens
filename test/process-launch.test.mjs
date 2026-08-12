import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareCommand,
  prepareResolvedCommand,
  resolveExecutable,
  terminateProcessTree,
} from '../lib/process-launch.mjs';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('resolveExecutable uses the platform lookup and first concrete result', async () => {
  const calls = [];
  let accessCalled = false;
  const lookup = async (...args) => {
    calls.push(args);
    return { stdout: 'C:\\Tools\\codex.cmd\r\nC:\\Tools\\codex.exe\r\n' };
  };

  assert.equal(
    await resolveExecutable('codex', {
      platform: 'win32',
      environment: { PATH: 'C:\\Tools' },
      lookup,
      access: async () => {
        accessCalled = true;
      },
    }),
    'C:\\Tools\\codex.cmd',
  );
  assert.deepEqual(calls[0].slice(0, 2), ['where.exe', ['codex']]);
  assert.equal(accessCalled, false);
});

for (const [platform, lookupCommand] of [
  ['linux', 'which'],
  ['win32', 'where.exe'],
]) {
  test(`prepareCommand bounds a hanging ${lookupCommand} lookup`, async () => {
    const calls = [];
    const start = Date.now();

    await assert.rejects(
      prepareCommand('reviewer', [], {
        platform,
        environment: { PATH: platform === 'win32' ? 'C:\\Tools' : '/tools' },
        lookup: async (...args) => {
          calls.push(args);
          await new Promise(() => {});
        },
        lookupTimeoutMs: 10,
      }),
      (error) => {
        assert.equal(error.code, 'ETIMEDOUT');
        assert.match(error.message, new RegExp(`${lookupCommand} lookup timed out`));
        return true;
      },
    );

    assert.equal(calls[0][0], lookupCommand);
    assert.deepEqual(calls[0][1], ['reviewer']);
    assert.equal(calls[0][2].timeout, 10);
    assert.ok(Date.now() - start < 500);
  });
}

test('resolveExecutable passes its timeout to execFile and bounds a timed child', async () => {
  const timeoutMs = 20;
  const calls = [];
  const lookup = (lookupCommand, args, options) => {
    calls.push({ lookupCommand, args, options });
    return execFileAsync(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 1000)'],
      options,
    );
  };
  const start = Date.now();

  await assert.rejects(
    resolveExecutable('reviewer', {
      platform: 'linux',
      environment: { PATH: '/tools' },
      lookup,
      lookupTimeoutMs: timeoutMs,
    }),
    { code: 'ETIMEDOUT' },
  );

  assert.equal(calls[0].lookupCommand, 'which');
  assert.deepEqual(calls[0].args, ['reviewer']);
  assert.equal(calls[0].options.timeout, timeoutMs);
  assert.ok(Date.now() - start < 500);
});

test('resolveExecutable prefers Windows PATHEXT matches over extensionless shims', async () => {
  const lookup = async () => ({
    stdout:
      'C:\\Users\\J\\AppData\\Roaming\\npm\\codex\r\n' +
      'C:\\Users\\J\\AppData\\Roaming\\npm\\codex.cmd\r\n' +
      'C:\\Users\\J\\AppData\\Roaming\\npm\\codex.ps1\r\n' +
      'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe\r\n',
  });

  assert.equal(
    await resolveExecutable('codex', {
      platform: 'win32',
      environment: {
        PATH: 'C:\\Users\\J\\AppData\\Roaming\\npm;C:\\Program Files\\WindowsApps',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      },
      lookup,
    }),
    'C:\\Users\\J\\AppData\\Roaming\\npm\\codex.cmd',
  );
});

test('resolveExecutable avoids WindowsApps aliases when a later npm cmd shim exists', async () => {
  const existing = new Set([
    'C:\\Users\\J\\AppData\\Roaming\\npm\\codex.cmd',
  ]);

  assert.equal(
    await resolveExecutable('codex', {
      platform: 'win32',
      environment: {
        PATH:
          'C:\\Users\\J\\AppData\\Local\\Microsoft\\WindowsApps;' +
          'C:\\Users\\J\\AppData\\Roaming\\npm',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      },
      lookup: async () => ({
        stdout:
          'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex\r\n' +
          'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe\r\n',
      }),
      access: async (candidate) => {
        if (!existing.has(candidate)) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
      },
    }),
    'C:\\Users\\J\\AppData\\Roaming\\npm\\codex.cmd',
  );
});

test('resolveExecutable bounds parallel Windows PATH fallback probes', async () => {
  const started = [];
  const start = Date.now();

  assert.equal(
    await resolveExecutable('codex', {
      platform: 'win32',
      environment: {
        PATH: 'C:\\Slow;C:\\AlsoSlow',
        PATHEXT: '.EXE;.CMD',
      },
      lookup: async () => ({
        stdout: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe\r\n',
      }),
      access: async (candidate) => {
        started.push(candidate);
        await new Promise(() => {});
      },
      pathProbeTimeoutMs: 10,
    }),
    'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe',
  );

  assert.deepEqual(started, [
    'C:\\Slow\\codex.exe',
    'C:\\Slow\\codex.cmd',
    'C:\\AlsoSlow\\codex.exe',
    'C:\\AlsoSlow\\codex.cmd',
  ]);
  assert.ok(Date.now() - start < 200);
});

test('resolveExecutable reads Windows environment keys case-insensitively', async () => {
  const lookup = async () => ({
    stdout:
      'C:\\Tools\\reviewer\r\n' +
      'C:\\Tools\\reviewer.exe\r\n',
  });

  assert.equal(
    await resolveExecutable('reviewer', {
      platform: 'win32',
      environment: {
        Path: 'C:\\Tools',
        PathExt: '.EXE',
      },
      lookup,
    }),
    'C:\\Tools\\reviewer.exe',
  );
});

test('resolveExecutable rejects unsupported Windows lookup results', async () => {
  const lookup = async () => ({
    stdout:
      'C:\\Users\\J\\AppData\\Roaming\\npm\\codex\r\n' +
      'C:\\Users\\J\\AppData\\Roaming\\npm\\codex.ps1\r\n',
  });

  await assert.rejects(
    resolveExecutable('codex', {
      platform: 'win32',
      environment: {
        PATH: 'C:\\Users\\J\\AppData\\Roaming\\npm',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      },
      lookup,
      access: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    }),
    { code: 'ENOENT' },
  );
});

test('prepareResolvedCommand keeps native executables shell-free', () => {
  assert.deepEqual(
    prepareResolvedCommand('/usr/local/bin/codex', ['exec'], { platform: 'linux' }),
    {
      command: '/usr/local/bin/codex',
      args: ['exec'],
      options: { shell: false },
    },
  );
  assert.deepEqual(
    prepareResolvedCommand('C:\\Tools\\codex.exe', ['exec'], { platform: 'win32' }),
    {
      command: 'C:\\Tools\\codex.exe',
      args: ['exec'],
      options: { shell: false },
    },
  );
});

test('prepareResolvedCommand launches Windows batch shims through ComSpec', () => {
  const prepared = prepareResolvedCommand(
    'C:\\Program Files\\Reviewer\\codex.cmd',
    ['exec', '--label=two words', 'a&b'],
    {
      platform: 'win32',
      environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    },
  );

  assert.equal(prepared.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(prepared.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(prepared.args[3], /codex\.cmd/);
  assert.match(prepared.args[3], /\^&/);
  assert.deepEqual(prepared.options, {
    shell: false,
    windowsVerbatimArguments: true,
  });
});

test('prepareCommand resolves a Windows npm shim before preparing it', async () => {
  const prepared = await prepareCommand('claude', ['-p', 'ok'], {
    platform: 'win32',
    environment: { PATH: 'C:\\npm', ComSpec: 'C:\\Windows\\cmd.exe' },
    lookup: async () => ({ stdout: 'C:\\npm\\claude.cmd\r\n' }),
  });

  assert.equal(prepared.command, 'C:\\Windows\\cmd.exe');
  assert.equal(prepared.options.windowsVerbatimArguments, true);
  assert.match(prepared.args[3], /claude\.cmd/);
});

test('prepareResolvedCommand double-escapes cmd metacharacters for npm shims', () => {
  const executable = 'C:\\repo\\node_modules\\.bin\\reviewer.cmd';
  const metaCharacters = '()[]%!^`<>&|;, *?';
  const expectedArgument = `^^^"${
    [...metaCharacters].map((character) => `^^^${character}`).join('')
  }^^^"`;

  const prepared = prepareResolvedCommand(executable, [metaCharacters], {
    platform: 'win32',
  });

  assert.equal(
    prepared.args[3],
    `"${executable} ${expectedArgument}"`,
  );
});

test('prepareResolvedCommand does not double-escape ordinary cmd scripts', () => {
  const executable = 'C:\\Tools\\reviewer.cmd';
  const metaCharacters = '()[]%!^`<>&|;, *?';
  const expectedArgument = `^"${
    [...metaCharacters].map((character) => `^${character}`).join('')
  }^"`;

  const prepared = prepareResolvedCommand(executable, [metaCharacters], {
    platform: 'win32',
  });

  assert.equal(
    prepared.args[3],
    `"${executable} ${expectedArgument}"`,
  );
});

test('terminateProcessTree uses a process group on POSIX', async (t) => {
  const signals = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push({ pid, signal });
  });

  await terminateProcessTree({ pid: 4321 }, {
    platform: 'linux',
    force: true,
  });

  assert.deepEqual(signals, [{ pid: -4321, signal: 'SIGKILL' }]);
});

test('terminateProcessTree uses taskkill for a forced Windows tree stop', async () => {
  let invocation;
  const spawnProcess = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child;
  };

  await terminateProcessTree({ pid: 4321 }, {
    platform: 'win32',
    force: true,
    spawnProcess,
  });

  assert.equal(invocation.command, 'taskkill.exe');
  assert.deepEqual(invocation.args, ['/pid', '4321', '/t', '/f']);
  assert.equal(invocation.options.shell, false);
});

for (const failure of [
  {
    name: 'an asynchronous taskkill error',
    emit(killer) {
      killer.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
    },
  },
  {
    name: 'a non-zero taskkill exit',
    emit(killer) {
      killer.emit('close', 1, null);
    },
  },
  {
    name: 'a timed-out taskkill process',
    emit(killer) {
      killer.emit('close', null, 'SIGTERM');
    },
  },
]) {
  test(`terminateProcessTree rejects ${failure.name}`, async () => {
    const signals = [];
    const target = {
      pid: 4321,
      kill(signal) {
        signals.push(signal);
        return true;
      },
    };
    const spawnProcess = () => {
      const killer = new EventEmitter();
      process.nextTick(() => failure.emit(killer));
      return killer;
    };

    await assert.rejects(
      terminateProcessTree(target, {
        platform: 'win32',
        force: true,
        spawnProcess,
      }),
      (err) => err?.code === 'ETERMINATE' && err?.pid === 4321,
    );
    assert.deepEqual(signals, ['SIGKILL']);
  });
}

test('terminateProcessTree rejects a synchronous taskkill launch failure', async () => {
  const signals = [];
  const target = {
    pid: 4321,
    kill(signal) {
      signals.push(signal);
      return true;
    },
  };

  await assert.rejects(
    terminateProcessTree(target, {
      platform: 'win32',
      force: true,
      spawnProcess() {
        throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
      },
    }),
    (err) => err?.code === 'ETERMINATE' && err?.pid === 4321,
  );
  assert.deepEqual(signals, ['SIGKILL']);
});

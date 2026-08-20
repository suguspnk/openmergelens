import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_REVIEWER_COMMAND,
  CODEX_REVIEWER_COMMAND,
} from '../lib/reviewer-command-defaults.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ACCOUNT = 'e2e-reviewer';
const FIXTURE_REPOSITORY = 'owner/repo';

function selectedBackend() {
  const backend = (process.env.OPENMERGELENS_E2E_INIT_BACKEND || 'claude')
    .trim()
    .toLowerCase();
  if (!['claude', 'codex'].includes(backend)) {
    throw new Error('OPENMERGELENS_E2E_INIT_BACKEND must be claude or codex');
  }
  return backend;
}

function selectedSchedulerMode() {
  const mode = (process.env.OPENMERGELENS_E2E_INIT_SCHEDULER || 'manual')
    .trim()
    .toLowerCase();
  if (!['manual', 'installed'].includes(mode)) {
    throw new Error('OPENMERGELENS_E2E_INIT_SCHEDULER must be manual or installed');
  }
  return mode;
}

function currentHostScheduler() {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') return 'cron';
  return undefined;
}

async function writeExecutable(filePath, contents) {
  await writeFile(filePath, `#!${process.execPath}\n${contents}`, 'utf8');
  await chmod(filePath, 0o755);
}

async function createFakeCommands(root, backend) {
  const binDirectory = path.join(root, 'bin');
  await mkdir(binDirectory, { recursive: true });
  const schedulerLog = path.join(root, 'scheduler-commands.log');
  const crontabState = path.join(root, 'crontab');

  await writeExecutable(
    path.join(binDirectory, 'gh'),
    `const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = process.env.FAKE_GH_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write('Logged in to github.com account ${FIXTURE_ACCOUNT}\\n' +
    '  - Active account: true\\n');
} else if (args[0] === 'auth' && args[1] === 'token') {
  process.stdout.write('fixture-token\\n');
} else if (args[0] === 'api' && args[1] === 'user' && args.includes('.login')) {
  process.stdout.write('${FIXTURE_ACCOUNT}\\n');
} else if (args[0] === 'api' && args.includes('user/repos')) {
  process.stdout.write(JSON.stringify({
    nameWithOwner: '${FIXTURE_REPOSITORY}',
    isPrivate: true,
  }) + '\\n');
} else {
  process.stderr.write('unexpected fake gh command: ' + args.join(' ') + '\\n');
  process.exitCode = 2;
}
`,
  );

  const reviewerScript = backend === 'claude'
    ? `const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('--setting-sources --tools dontAsk\\n');
} else if (args.includes('-p')) {
  process.stdout.write('ok\\n');
} else {
  process.stderr.write('unexpected fake Claude command\\n');
  process.exitCode = 2;
}
`
    : `const args = process.argv.slice(2);
if (args[0] === 'exec' && args.includes('--help')) {
  process.stdout.write('codex exec --help\\n');
} else if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in\\n');
} else {
  process.stderr.write('unexpected fake Codex command\\n');
  process.exitCode = 2;
}
`;
  await writeExecutable(path.join(binDirectory, backend), reviewerScript);
  await writeExecutable(
    path.join(binDirectory, 'which'),
    `const binary = process.argv[2];
if (binary === '${backend}') {
  process.stdout.write(process.env.FAKE_REVIEWER_PATH + '\\n');
} else {
  process.exitCode = 1;
}
`,
  );

  await writeExecutable(
    path.join(binDirectory, 'launchctl'),
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SCHEDULER_LOG, 'launchctl ' + args.join(' ') + '\\n');
if (args[0] === 'unload') {
  process.stderr.write('No such file or directory\\n');
  process.exitCode = 1;
} else if (args[0] !== 'load') {
  process.stderr.write('unexpected fake launchctl command\\n');
  process.exitCode = 2;
}
`,
  );
  await writeExecutable(
    path.join(binDirectory, 'crontab'),
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SCHEDULER_LOG, 'crontab ' + args.join(' ') + '\\n');
if (args[0] === '-l' && !fs.existsSync(process.env.FAKE_CRONTAB_STATE)) {
  process.stderr.write('no crontab for test user\\n');
  process.exitCode = 1;
} else if (args[0] === '-') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => fs.writeFileSync(process.env.FAKE_CRONTAB_STATE, input));
} else if (args[0] !== '-l') {
  process.stderr.write('unexpected fake crontab command\\n');
  process.exitCode = 2;
}
`,
  );

  return {
    binDirectory,
    crontabState,
    environment: {
      ...process.env,
      PATH: binDirectory,
      FAKE_GH_LOG: path.join(root, 'gh-commands.log'),
      FAKE_REVIEWER_PATH: path.join(binDirectory, backend),
      FAKE_SCHEDULER_LOG: schedulerLog,
      FAKE_CRONTAB_STATE: crontabState,
    },
    schedulerLog,
  };
}

async function expectCommand() {
  try {
    const { stdout } = await execFileAsync('which', ['expect'], {
      env: process.env,
      timeout: 5_000,
    });
    return stdout.trim();
  } catch {
    throw new Error('the interactive init E2E requires the `expect` command');
  }
}

function expectScript({ schedulerDownCount, installedScheduler }) {
  const initPath = path.join(projectRoot, 'bin', 'init.mjs');
  const nodePath = process.execPath.replaceAll('\\', '\\\\');
  const escapedInitPath = initPath.replaceAll('\\', '\\\\');
  const schedulerNavigation = Array.from(
    { length: schedulerDownCount },
    () => '    send "\\033\\[B"',
  ).join('\n');
  return `
set timeout 45
log_user 1
set stty_init "rows 40 columns 120"
spawn "${nodePath}" "${escapedInitPath}"
expect {
  -re {Which repository providers should OpenMergeLens configure} {
    after 100
    send "\r"
  }
  timeout { exit 19 }
}
expect {
  -re {Which GitHub accounts should watch} {
    after 100
    send "\\r"
  }
  timeout { exit 20 }
}
expect {
  -re {Which repositories should} {
    after 100
    send "\\r"
  }
  timeout { exit 21 }
}
expect {
  -re {Which shared reviewer backend should} { send "\\r" }
  timeout { exit 22 }
}
expect {
  -re {Which .* model should review PRs} { send "\\r" }
  timeout { exit 23 }
}
expect {
  -re {Authorize third-party AI processing} { send "y" }
  timeout { exit 24 }
}
expect {
  -re {How many shared review focus categories} { send "\\r" }
  timeout { exit 25 }
}
expect {
  -re {Show a desktop notification} { send "n" }
  timeout { exit 26 }
}
expect {
  -re {How should the shared multi-account poller run} {
${schedulerNavigation}
    send "\\r"
  }
  timeout { exit 27 }
}
${installedScheduler ? `expect {
  -re {How often should it poll} { send "\\r" }
  timeout { exit 30 }
}` : ''}
expect {
  -re {Apply this complete configuration} { send "\\r" }
  timeout { exit 28 }
}
expect {
  -re {Setup complete} {}
  timeout { exit 29 }
}
expect eof
set waitResult [wait]
exit [lindex $waitResult 3]
`;
}

async function runInteractiveInit({ command, environment, schedulerDownCount, installedScheduler }) {
  const child = spawn(command, ['-c', expectScript({ schedulerDownCount, installedScheduler })], {
    cwd: projectRoot,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('interactive init E2E timed out'));
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end();
  });
}

test(
  `interactive init writes an isolated configuration through a real PTY (${selectedSchedulerMode()} scheduler)`,
  {
    skip: process.platform === 'win32'
      ? 'the portable setup smoke currently targets POSIX PTY hosts'
      : selectedSchedulerMode() === 'installed' && !currentHostScheduler()
        ? 'no installed scheduler fixture is defined for this host'
        : false,
    timeout: 75_000,
  },
  async (t) => {
    const backend = selectedBackend();
    const schedulerMode = selectedSchedulerMode();
    const scheduler = currentHostScheduler();
    if (schedulerMode === 'installed' && !scheduler) {
      throw new Error(`no installed scheduler fixture is defined for ${process.platform}`);
    }
    const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-init-e2e-'));
    const home = path.join(root, 'home');
    await mkdir(home, { recursive: true });
    const fake = await createFakeCommands(root, backend);
    const reviewerCommand = backend === 'claude'
      ? CLAUDE_REVIEWER_COMMAND
      : CODEX_REVIEWER_COMMAND;
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({
        configVersion: 5,
        githubAccounts: [{
          hostname: 'github.com',
          username: FIXTURE_ACCOUNT,
          repositories: [FIXTURE_REPOSITORY],
        }],
        aiProcessingConsent: null,
        reviewerCommand,
        model: null,
        reviewerInputMode: 'stdin',
        reviewBatchSize: 5,
        reviewFocusCount: 4,
        desktopNotifications: false,
        stateFile: './state.json',
      }, null, 2) + '\n',
      'utf8',
    );
    t.after(() => rm(root, { recursive: true, force: true }));

    const result = await runInteractiveInit({
      command: await expectCommand(),
      environment: {
        ...fake.environment,
        OPENMERGELENS_HOME: home,
        OPENMERGELENS_E2E_SCHEDULER_HOME: path.join(root, 'scheduler-home'),
      },
      schedulerDownCount: schedulerMode === 'installed'
        ? 0
        : process.platform === 'darwin'
          ? 2
          : 1,
      installedScheduler: schedulerMode === 'installed',
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /Setup complete/u);

    const config = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
    assert.deepEqual(config.githubAccounts, [{
      hostname: 'github.com',
      username: FIXTURE_ACCOUNT,
      repositories: [FIXTURE_REPOSITORY],
    }]);
    assert.equal(config.desktopNotifications, false);
    assert.equal(config.reviewerCommand.includes(backend), true);
    assert.equal(
      await readFile(
        path.join(home, 'docs', 'review-prompts', 'github.com', 'owner', 'repo.md'),
        'utf8',
      ).then((content) => content.length > 0),
      true,
    );
    assert.equal(
      await readFile(
        path.join(home, 'docs', 'learnings', 'github.com', FIXTURE_ACCOUNT, 'owner', 'repo.md'),
        'utf8',
      ),
      '',
    );
    const schedulerLog = await readFile(fake.schedulerLog, 'utf8');
    const schedulerEnvironmentPath = path.join(home, 'scheduler-environment.json');
    const pollLogPath = path.join(home, 'poll.log');
    if (schedulerMode === 'manual') {
      assert.match(schedulerLog, /launchctl unload|crontab -l/u);
      await assert.rejects(access(schedulerEnvironmentPath), { code: 'ENOENT' });
      await assert.rejects(access(pollLogPath), { code: 'ENOENT' });
    } else if (scheduler === 'launchd') {
      assert.match(schedulerLog, /launchctl unload[\s\S]*launchctl load/u);
      assert.match(
        await readFile(
          path.join(
            root,
            'scheduler-home',
            'Library',
            'LaunchAgents',
            'io.github.suguspnk.openmergelens.poll.plist',
          ),
          'utf8',
        ),
        /<key>StartInterval<\/key>\s*<integer>900<\/integer>/u,
      );
      assert.equal(JSON.parse(await readFile(schedulerEnvironmentPath, 'utf8')).OPENMERGELENS_HOME, home);
      await access(pollLogPath);
    } else {
      assert.match(schedulerLog, /crontab -l[\s\S]*crontab -/u);
      assert.match(await readFile(fake.crontabState, 'utf8'), /# openmergelens:managed:cron:v1/u);
      assert.equal(JSON.parse(await readFile(schedulerEnvironmentPath, 'utf8')).OPENMERGELENS_HOME, home);
      await access(pollLogPath);
    }
    await assert.rejects(access(path.join(home, 'operation.lock')), { code: 'ENOENT' });
  },
);

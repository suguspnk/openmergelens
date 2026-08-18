import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHome, environmentWithTestHome } from './test-home.mjs';
import {
  applyScheduleSelection,
  buildSetupConfig,
  canonicalRepositorySelections,
  finalizeSetup,
  isInteractiveTerminal,
  recheckReviewerAgent,
  reviewerBackendOptions,
  selectableReviewerAgents,
  validateScheduleInterval,
} from '../bin/init.mjs';
import { createAiProcessingConsent } from '../lib/ai-processing-consent.mjs';
import { CODEX_REVIEWER_COMMAND } from '../lib/reviewer-command-defaults.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('interactive terminal detection requires TTY stdin and stdout', () => {
  assert.equal(isInteractiveTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
  assert.equal(isInteractiveTerminal({ stdin: { isTTY: false }, stdout: { isTTY: true } }), false);
  assert.equal(isInteractiveTerminal({ stdin: { isTTY: true }, stdout: { isTTY: false } }), false);
});

test('repository selection restores canonical GitHub casing', () => {
  assert.deepEqual(
    canonicalRepositorySelections(
      ['owner/repo', 'missing/repo'],
      [
        { nameWithOwner: 'OWNER/REPO' },
        { nameWithOwner: 'other/project' },
      ],
    ),
    ['OWNER/REPO'],
  );
});

test('init interval validation follows each scheduler contract', () => {
  assert.equal(validateScheduleInterval('15', 'cron'), undefined);
  assert.match(validateScheduleInterval('7', 'cron'), /supported cron intervals/);
  assert.match(validateScheduleInterval('59', 'cron'), /supported cron intervals/);
  assert.equal(validateScheduleInterval('90', 'launchd'), undefined);
  assert.equal(validateScheduleInterval('90', 'schtasks'), undefined);
  assert.equal(validateScheduleInterval('1439', 'launchd'), undefined);
  assert.equal(validateScheduleInterval('1439', 'schtasks'), undefined);
  assert.match(validateScheduleInterval('0', 'launchd'), /positive whole number/);
  assert.match(validateScheduleInterval('1.5', 'schtasks'), /positive whole number/);
  assert.match(validateScheduleInterval('1e100', 'launchd'), /positive whole number/);
  assert.match(validateScheduleInterval('9007199254740992', 'schtasks'), /positive whole number/);
  assert.match(validateScheduleInterval('Infinity', 'launchd'), /positive whole number/);
  assert.match(validateScheduleInterval('1440', 'schtasks'), /1 through 1439/);
});

test('init preserves a manually configured reviewer timeout when rebuilding config', () => {
  const githubAccounts = [{
    hostname: 'github.com',
    username: 'work',
    repositories: ['owner/repo'],
  }];
  const existingConfig = {
    configVersion: 5,
    githubAccounts,
    aiProcessingConsent: createAiProcessingConsent(
      CODEX_REVIEWER_COMMAND,
      githubAccounts,
    ),
    reviewerCommand: CODEX_REVIEWER_COMMAND,
    model: null,
    reviewBatchSize: 2,
    reviewFocusCount: 4,
    reviewTimeoutMs: 15 * 60 * 1000,
    desktopNotifications: true,
    stateFile: './state.json',
  };

  const rebuilt = buildSetupConfig({
    githubAccounts,
    aiProcessingConsent: existingConfig.aiProcessingConsent,
    reviewerCommand: existingConfig.reviewerCommand,
    model: existingConfig.model,
    reviewFocusCount: existingConfig.reviewFocusCount,
    desktopNotifications: false,
    existingConfig,
  });

  assert.equal(rebuilt.reviewTimeoutMs, existingConfig.reviewTimeoutMs);
  assert.equal(rebuilt.desktopNotifications, false);
});

test('init preserves normalized Bitbucket Cloud accounts when rebuilding config', () => {
  const githubAccounts = [{
    hostname: 'github.com',
    username: 'work',
    repositories: ['owner/repo'],
  }];
  const bitbucketAccounts = [{
    hostname: 'bitbucket.org',
    accountId: '{123e4567-e89b-42d3-a456-426614174000}',
    credentialUsername: 'reviewer@example.com',
    repositories: ['workspace/repo'],
  }];
  const allAccounts = [...githubAccounts, ...bitbucketAccounts];
  const existingConfig = {
    configVersion: 6,
    githubAccounts,
    bitbucketAccounts,
    aiProcessingConsent: createAiProcessingConsent(CODEX_REVIEWER_COMMAND, allAccounts),
    reviewerCommand: CODEX_REVIEWER_COMMAND,
    model: null,
    reviewBatchSize: 2,
    reviewFocusCount: 4,
    reviewTimeoutMs: 15 * 60 * 1000,
    desktopNotifications: true,
    stateFile: './state.json',
  };

  const rebuilt = buildSetupConfig({
    githubAccounts,
    aiProcessingConsent: existingConfig.aiProcessingConsent,
    reviewerCommand: existingConfig.reviewerCommand,
    model: existingConfig.model,
    reviewFocusCount: existingConfig.reviewFocusCount,
    desktopNotifications: true,
    existingConfig,
  });

  assert.deepEqual(rebuilt.bitbucketAccounts, bitbucketAccounts);
});

test('init rejects an unsupported cron interval before scheduler reconciliation', async () => {
  let reconciled = false;

  await assert.rejects(
    applyScheduleSelection({
      scheduleChoice: 'cron',
      intervalMinutes: 7,
      platform: 'linux',
      reconcile: async () => {
        reconciled = true;
      },
    }),
    /exact hourly cadence: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 minutes/,
  );
  assert.equal(reconciled, false);
});

test('init rejects an unsafe host interval before scheduler reconciliation', async () => {
  let reconciled = false;

  await assert.rejects(
    applyScheduleSelection({
      scheduleChoice: 'launchd',
      intervalMinutes: Number.MAX_SAFE_INTEGER + 1,
      platform: 'darwin',
      reconcile: async () => {
        reconciled = true;
      },
    }),
    /positive whole number of minutes from 1 through 1439/,
  );
  assert.equal(reconciled, false);
});

test('init routes scheduled and manual choices through scheduler lifecycle reconciliation', async () => {
  const calls = [];
  const reconcile = async (options) => {
    calls.push(options);
  };
  const installLaunchd = async () => {};

  await applyScheduleSelection({
    scheduleChoice: 'launchd',
    intervalMinutes: 30,
    platform: 'darwin',
    selectedPollScriptPath: '/opt/openmergelens/bin/poll.mjs',
    installFns: { launchd: installLaunchd },
    reconcile,
  });
  await applyScheduleSelection({
    scheduleChoice: 'manual',
    platform: 'darwin',
    installFns: {},
    reconcile,
  });

  assert.equal(calls[0].scheduler, 'launchd');
  assert.equal(calls[0].intervalMinutes, 30);
  assert.equal(calls[0].pollScriptPath, '/opt/openmergelens/bin/poll.mjs');
  assert.equal(calls[0].install, installLaunchd);
  assert.equal(calls[1].scheduler, 'manual');
  assert.equal('install' in calls[1], false);
});

test('init does not report setup success after a schedule transition failure', async () => {
  const spinnerEvents = [];
  const outroMessages = [];
  const exitCodes = [];
  let notificationsVerified = false;

  const completed = await finalizeSetup({
    scheduleChoice: 'launchd',
    intervalMinutes: 15,
    account: { hostname: 'github.com', username: 'alice' },
    desktopNotifications: true,
    applySchedule: async () => {
      throw new Error('permission denied');
    },
    verifyNotifications: async () => {
      notificationsVerified = true;
    },
    spinner: {
      start: (message) => spinnerEvents.push(['start', message]),
      stop: (message) => spinnerEvents.push(['stop', message]),
    },
    outro: (message) => outroMessages.push(message),
    setExitCode: (code) => exitCodes.push(code),
  });

  assert.equal(completed, false);
  assert.deepEqual(spinnerEvents, [
    ['start', 'Installing launchd entry'],
    ['stop', 'Configuration saved, but schedule transition failed: permission denied'],
  ]);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(notificationsVerified, false);
  assert.equal(outroMessages.length, 1);
  assert.match(outroMessages[0], /Setup incomplete/);
  assert.doesNotMatch(outroMessages[0], /Setup complete/);
});

test('init forwards isolated scheduler options through finalization', async () => {
  let received;

  const completed = await finalizeSetup({
    scheduleChoice: 'manual',
    intervalMinutes: 15,
    account: { hostname: 'github.com', username: 'alice' },
    desktopNotifications: false,
    schedulerOptions: { homeDirectory: '/tmp/openmergelens-test-scheduler' },
    applySchedule: async (options) => {
      received = options;
    },
    spinner: {
      start() {},
      stop() {},
    },
    outro() {},
  });

  assert.equal(completed, true);
  assert.deepEqual(received, {
    scheduleChoice: 'manual',
    intervalMinutes: 15,
    schedulerOptions: { homeDirectory: '/tmp/openmergelens-test-scheduler' },
  });
});

test('init exits clearly instead of waiting for prompts without a TTY', async (t) => {
  const userHome = await createTestHome(t, 'openmergelens-init-');

  const child = spawn(process.execPath, ['bin/init.mjs'], {
    cwd: projectRoot,
    env: environmentWithTestHome(process.env, userHome),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  const result = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('init did not exit promptly without a TTY'));
    }, 1_500);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
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

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /init requires an interactive terminal \(TTY\)/i);
});

test('reviewer backend selector omits CLIs that are not found', () => {
  const agents = [
    { id: 'claude', status: 'not-found' },
    { id: 'codex', status: 'ready' },
    { id: 'other', status: 'unauthenticated' },
  ];

  assert.deepEqual(
    selectableReviewerAgents(agents).map(({ id }) => id),
    ['codex', 'other'],
  );
});

test('reviewer backend selector always keeps the custom command option', () => {
  assert.deepEqual(
    reviewerBackendOptions([
      { id: 'claude', label: 'Claude Code', status: 'not-found' },
      { id: 'codex', label: 'Codex CLI', status: 'not-found' },
    ]).map(({ value }) => value),
    ['custom'],
  );
});

test('reviewer auth re-check accepts the same backend after login succeeds', async () => {
  const selectedAgent = {
    id: 'codex',
    label: 'Codex CLI',
    status: 'unauthenticated',
  };

  const verifiedAgent = await recheckReviewerAgent({
    selectedAgent,
    detect: async () => [
      { ...selectedAgent, status: 'ready', executable: '/usr/local/bin/codex' },
    ],
  });

  assert.equal(verifiedAgent.status, 'ready');
  assert.equal(verifiedAgent.id, selectedAgent.id);
});

test('reviewer auth re-check rejects a backend that is still unavailable or fails to check', async () => {
  const selectedAgent = {
    id: 'codex',
    label: 'Codex CLI',
    status: 'unauthenticated',
  };

  for (const status of ['unauthenticated', 'not-found', 'incompatible']) {
    const result = await recheckReviewerAgent({
      selectedAgent,
      detect: async () => [{ ...selectedAgent, status }],
    });
    assert.equal(result, null, `expected ${status} re-check to cancel`);
  }

  const failedResult = await recheckReviewerAgent({
    selectedAgent,
    detect: async () => {
      throw new Error('reviewer probe failed');
    },
  });
  assert.equal(failedResult, null);
});

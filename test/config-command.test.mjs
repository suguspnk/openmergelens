import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  configMenuOptions,
  configLoadErrorMessage,
  persistConfigUpdate,
  reviewBehaviorMenuOptions,
} from '../lib/config-editor.mjs';
import {
  CLAUDE_REVIEWER_COMMAND,
} from '../lib/reviewer-command-defaults.mjs';
import { validateConfig } from '../lib/config.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function createConfig() {
  return validateConfig({
    configVersion: 5,
    githubAccounts: [{
      hostname: 'github.com',
      username: 'alice',
      repositories: ['OWNER/REPO'],
    }],
    aiProcessingConsent: null,
    reviewerCommand: CLAUDE_REVIEWER_COMMAND,
    model: null,
    reviewerInputMode: 'stdin',
    reviewBatchSize: 5,
    reviewFocusCount: 4,
    reviewTimeoutMs: 1800000,
    desktopNotifications: true,
    stateFile: './state.json',
  });
}

function createBitbucketConfig() {
  const account = {
    accountId: '{123e4567-e89b-42d3-a456-426614174000}',
    credentialUsername: 'reviewer@example.com',
    repositories: ['workspace/repo'],
  };
  return validateConfig({
    ...createConfig(),
    githubAccounts: [],
    bitbucketAccounts: [account],
  });
}

test('config menus expose every mutable area and current values', () => {
  const config = createConfig();
  const options = configMenuOptions(config);

  assert.deepEqual(
    options.map(({ value }) => value),
    ['accounts', 'reviewer', 'review', 'notifications', 'schedule', 'view', 'exit'],
  );
  assert.match(options.find(({ value }) => value === 'accounts').hint, /1 account/);
  assert.match(options.find(({ value }) => value === 'reviewer').hint, /Claude Code/);
  assert.match(options.find(({ value }) => value === 'review').hint, /batch 5/);
  assert.match(options.find(({ value }) => value === 'review').hint, /timeout 1800000ms/);
  assert.equal(
    reviewBehaviorMenuOptions(config).find(({ value }) => value === 'timeout').hint,
    '1800000 ms',
  );
  assert.equal(
    reviewBehaviorMenuOptions(config).find(({ value }) => value === 'state-file').hint,
    './state.json',
  );
});

test('config updates save immediately and skip redundant writes', async () => {
  const currentConfig = createConfig();
  const writes = [];
  const save = async (configPath, config) => {
    writes.push({ configPath, config });
    return config;
  };

  const changed = await persistConfigUpdate({
    configPath: '/tmp/openmergelens-config.json',
    currentConfig,
    nextConfig: { ...currentConfig, reviewBatchSize: 2 },
    save,
  });
  assert.equal(changed.changed, true);
  assert.equal(changed.config.reviewBatchSize, 2);
  assert.equal(writes.length, 1);

  const unchanged = await persistConfigUpdate({
    configPath: '/tmp/openmergelens-config.json',
    currentConfig: changed.config,
    nextConfig: { ...changed.config },
    save,
  });
  assert.equal(unchanged.changed, false);
  assert.equal(writes.length, 1);
});

test('config editor preserves normalized Bitbucket accounts through an unrelated edit', async () => {
  const currentConfig = createBitbucketConfig();
  const writes = [];
  const changed = await persistConfigUpdate({
    configPath: '/tmp/openmergelens-config.json',
    currentConfig,
    nextConfig: { ...currentConfig, reviewBatchSize: 2 },
    save: async (_configPath, config) => {
      writes.push(config);
      return config;
    },
  });

  assert.equal(changed.changed, true);
  assert.equal(changed.config.reviewBatchSize, 2);
  assert.deepEqual(changed.config.bitbucketAccounts, currentConfig.bitbucketAccounts);
  assert.equal(writes.length, 1);
});

test('config validation failures keep the existing file untouched and explain recovery', async () => {
  const currentConfig = createConfig();
  const writes = [];

  await assert.rejects(
    persistConfigUpdate({
      configPath: '/tmp/openmergelens-config.json',
      currentConfig,
      nextConfig: { ...currentConfig, reviewBatchSize: 0 },
      save: async (...args) => writes.push(args),
    }),
    /reviewBatchSize must be a whole number/,
  );
  assert.equal(writes.length, 0);
  assert.match(
    configLoadErrorMessage(new Error('config.json is not valid JSON')),
    /run `openmergelens init` first/,
  );
  assert.equal(
    configLoadErrorMessage(new Error('no config found; run `openmergelens init` first')),
    'no config found; run `openmergelens init` first',
  );
});

test('config exits clearly instead of waiting for prompts without a TTY', async (t) => {
  const child = spawn(process.execPath, ['bin/config.mjs'], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  const result = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('config did not exit promptly without a TTY'));
    }, 1_500);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
    child.stdin.end();
  });

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /config requires an interactive terminal \(TTY\)/i);
});

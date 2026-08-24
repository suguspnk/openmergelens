import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  configMenuOptions,
  configLoadErrorMessage,
  editAccounts,
  editReviewer,
  persistConfigUpdate,
  removeProviderAccounts,
  replaceProviderAccounts,
  reviewerOptionsWithCurrent,
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

test('config editor prunes attribution overrides for repositories it removes', async () => {
  const currentConfig = validateConfig({
    ...createConfig(),
    reviewAttribution: { 'github.com/OWNER/REPO': false },
  });
  const changed = await persistConfigUpdate({
    configPath: '/tmp/openmergelens-config.json',
    currentConfig,
    nextConfig: {
      ...currentConfig,
      githubAccounts: [],
      bitbucketAccounts: [{
        accountId: '{123e4567-e89b-42d3-a456-426614174000}',
        credentialUsername: 'reviewer@example.com',
        repositories: ['workspace/repo'],
      }],
    },
    save: async (_configPath, config) => config,
  });

  assert.equal(changed.changed, true);
  assert.deepEqual(changed.config.reviewAttribution, {});
});

test('Bitbucket discovery failure prevents consent, review files, and config save', async () => {
  const currentConfig = createBitbucketConfig();
  const calls = { consent: 0, files: 0, saves: 0 };
  let promptIndex = 0;
  await assert.rejects(editAccounts(currentConfig, {
    prompts: {
      select: async () => ['bitbucket', 'edit'][promptIndex++],
      isCancel: () => false,
      log: { error: () => {} },
    },
    configureBitbucket: async () => {
      const error = new Error(
        'Bitbucket workspace "Workspace" is unavailable (HTTP 410); configuration was not changed',
      );
      error.status = 410;
      throw error;
    },
    updateConsent: async () => { calls.consent += 1; },
    ensureReviewFiles: async () => { calls.files += 1; },
    saveUpdate: async () => { calls.saves += 1; },
  }), /configuration was not changed/u);
  assert.deepEqual(calls, { consent: 0, files: 0, saves: 0 });
});

test('provider account edits preserve the other provider until it is explicitly edited', () => {
  const bitbucketConfig = createBitbucketConfig();
  const githubAccount = {
    hostname: 'github.com',
    username: 'alice',
    repositories: ['OWNER/REPO'],
  };
  const withGitHub = replaceProviderAccounts(bitbucketConfig, 'github', [githubAccount]);
  assert.deepEqual(withGitHub.githubAccounts, [githubAccount]);
  assert.deepEqual(withGitHub.bitbucketAccounts, bitbucketConfig.bitbucketAccounts);

  const replacementBitbucket = [{
    ...bitbucketConfig.bitbucketAccounts[0],
    repositories: ['workspace/other'],
  }];
  const withBitbucket = replaceProviderAccounts(withGitHub, 'bitbucket', replacementBitbucket);
  assert.deepEqual(withBitbucket.githubAccounts, [githubAccount]);
  assert.deepEqual(withBitbucket.bitbucketAccounts, replacementBitbucket);
  assert.throws(
    () => replaceProviderAccounts(withGitHub, 'gitlab', []),
    /unknown repository provider/u,
  );
});

test('provider removal preserves the other provider and saves the consented result', async () => {
  const bitbucketConfig = createBitbucketConfig();
  const mixed = replaceProviderAccounts(bitbucketConfig, 'github', [{
    hostname: 'github.com', username: 'alice', repositories: ['OWNER/REPO'],
  }]);
  for (const provider of ['github', 'bitbucket']) {
    const saves = [];
    const result = await removeProviderAccounts(mixed, provider, {
      confirmRemoval: async () => true,
      updateConsent: async (_current, candidate) => ({
        ...candidate,
        aiProcessingConsent: { renewed: provider },
      }),
      saveUpdate: async (_current, candidate) => {
        saves.push(candidate);
        return candidate;
      },
    });
    assert.equal(result.changed, true);
    assert.equal(result.config[`${provider}Accounts`].length, 0);
    const otherProvider = provider === 'github' ? 'bitbucket' : 'github';
    assert.deepEqual(result.config[`${otherProvider}Accounts`], mixed[`${otherProvider}Accounts`]);
    assert.equal(saves.length, 1);
  }
});

test('provider removal rejects the last total account and cancellation or consent decline never save', async () => {
  const onlyBitbucket = createBitbucketConfig();
  let saves = 0;
  const lastAccount = await removeProviderAccounts(onlyBitbucket, 'bitbucket', {
    confirmRemoval: async () => true,
    saveUpdate: async () => { saves += 1; },
  });
  assert.equal(lastAccount.reason, 'last-account');

  const mixed = replaceProviderAccounts(onlyBitbucket, 'github', [{
    hostname: 'github.com', username: 'alice', repositories: ['OWNER/REPO'],
  }]);
  const cancelled = await removeProviderAccounts(mixed, 'github', {
    confirmRemoval: async () => false,
    saveUpdate: async () => { saves += 1; },
  });
  assert.equal(cancelled.reason, 'cancelled');
  const declined = await removeProviderAccounts(mixed, 'github', {
    confirmRemoval: async () => true,
    updateConsent: async () => null,
    saveUpdate: async () => { saves += 1; },
  });
  assert.equal(declined.reason, 'consent-declined');
  assert.equal(saves, 0);
  assert.deepEqual(cancelled.config, mixed);
  assert.deepEqual(declined.config, mixed);
});

test('Bitbucket account edits stop before credentials, consent, files, or saves for a custom backend', async () => {
  const incompatible = {
    ...createBitbucketConfig(),
    reviewerCommand: 'custom --mcp {{mcp_config}} --tool {{mcp_tool}}',
    model: null,
  };
  const calls = { credentials: 0, consent: 0, files: 0, saves: 0 };
  const result = await editAccounts(incompatible, {
    prompts: {
      select: async () => 'bitbucket',
      isCancel: () => false,
      log: { error: () => {}, warn: () => {} },
    },
    configureBitbucket: async () => { calls.credentials += 1; return []; },
    updateConsent: async () => { calls.consent += 1; },
    ensureReviewFiles: async () => { calls.files += 1; },
    saveUpdate: async () => { calls.saves += 1; },
  });
  assert.equal(result, incompatible);
  assert.deepEqual(calls, { credentials: 0, consent: 0, files: 0, saves: 0 });
});

test('Bitbucket configurations cannot switch to custom while GitHub-only custom remains supported', async () => {
  const bitbucketConfig = createBitbucketConfig();
  const bitbucketCalls = { text: 0, consent: 0, saves: 0 };
  const bitbucketResult = await editReviewer(bitbucketConfig, {
    detect: async () => [{ id: 'claude', label: 'Claude Code', status: 'ready' }],
    prompts: {
      select: async ({ options }) => {
        assert.equal(options.some(({ value }) => value === 'custom'), false);
        return 'custom';
      },
      text: async () => { bitbucketCalls.text += 1; },
      isCancel: () => false,
      log: { error: () => {}, warn: () => {} },
    },
    updateConsent: async () => { bitbucketCalls.consent += 1; },
    saveUpdate: async () => { bitbucketCalls.saves += 1; },
  });
  assert.equal(bitbucketResult, bitbucketConfig);
  assert.deepEqual(bitbucketCalls, { text: 0, consent: 0, saves: 0 });
  assert.equal(reviewerOptionsWithCurrent([], bitbucketConfig).some(({ value }) => value === 'custom'), false);

  const githubConfig = createConfig();
  const customCommand = 'custom --mcp {{mcp_config}} --tool {{mcp_tool}}';
  const githubResult = await editReviewer(githubConfig, {
    detect: async () => [],
    prompts: {
      select: async ({ options }) => {
        assert.equal(options.some(({ value }) => value === 'custom'), true);
        return 'custom';
      },
      text: async () => customCommand,
      isCancel: () => false,
      log: { error: () => {}, warn: () => {} },
    },
    updateConsent: async (_current, candidate) => candidate,
    saveUpdate: async (_current, candidate) => candidate,
  });
  assert.equal(githubResult.reviewerCommand, customCommand);
  assert.equal(githubResult.model, null);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accountKey,
  accountLabel,
  loadConfig,
  normalizeBitbucketRepository,
  normalizeBitbucketWorkspace,
  parseAccountSelector,
  reviewAttributionEnabled,
  reviewAttributionKey,
  saveConfig,
  validateConfig,
} from '../lib/config.mjs';
import {
  CLAUDE_REVIEWER_COMMAND,
  CODEX_REVIEWER_COMMAND,
  PREVIOUS_CODEX_REVIEWER_COMMAND,
  PR_LINK_CODEX_REVIEWER_COMMAND,
  reviewerCommandForModel,
  reviewerCommandForGitHubGateway,
  reviewerCommandForGitHubHost,
} from '../lib/reviewer-command-defaults.mjs';
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  MAX_REVIEW_TIMEOUT_MS,
  MIN_REVIEW_TIMEOUT_MS,
  parseCommand,
} from '../lib/reviewer-adapter.mjs';
import {
  createAiProcessingConsent,
  hasAiProcessingConsent,
} from '../lib/ai-processing-consent.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Bitbucket workspace validation allows Cloud’s 62-character limit without broadening GitHub owners', () => {
  const workspace = `a${'b'.repeat(61)}`;
  assert.equal(
    normalizeBitbucketRepository(`${workspace}/repo`),
    `${workspace}/repo`,
  );
  assert.throws(
    () => validateConfig({
      configVersion: 6,
      githubAccounts: [{
        hostname: 'github.com', username: 'reviewer', repositories: [`${workspace}/repo`],
      }],
      bitbucketAccounts: [],
      aiProcessingConsent: createAiProcessingConsent('codex exec', []),
      reviewerCommand: 'codex exec',
    }),
    /GitHub repository/u,
  );
});

test('Bitbucket workspace normalization is strict and preserves canonical API spelling', () => {
  const workspace = `a${'b'.repeat(61)}`;
  assert.equal(normalizeBitbucketWorkspace(workspace), workspace);
  assert.equal(normalizeBitbucketWorkspace('Workspace_Name'), 'Workspace_Name');
  assert.equal(normalizeBitbucketWorkspace(' workspace '), 'workspace');
  for (const invalid of ['', '-workspace', 'workspace.', `a${'b'.repeat(62)}`]) {
    assert.throws(() => normalizeBitbucketWorkspace(invalid), /workspace/u);
  }
  assert.throws(() => normalizeBitbucketWorkspace(null), /must be a string/u);
});

const validAccounts = [
  {
    hostname: 'github.com',
    username: 'work-user',
    repositories: ['Company/API', 'Company/web'],
  },
  {
    hostname: 'enterprise.example.com',
    username: 'personal',
    repositories: ['owner/repo'],
  },
];
const validConfig = {
  configVersion: 5,
  githubAccounts: validAccounts,
  aiProcessingConsent: createAiProcessingConsent(
    CODEX_REVIEWER_COMMAND,
    validAccounts,
  ),
  reviewerCommand: 'codex exec',
  reviewBatchSize: 5,
  reviewFocusCount: 4,
  stateFile: './state.json',
};

test('validates and normalizes a version 5 multi-account config', () => {
  assert.deepEqual(validateConfig(validConfig), {
    ...validConfig,
    configVersion: 6,
    bitbucketAccounts: [],
    reviewTimeoutMs: DEFAULT_REVIEW_TIMEOUT_MS,
    model: null,
    githubAccounts: validConfig.githubAccounts,
    reviewerCommand: CODEX_REVIEWER_COMMAND,
    reviewerInputMode: 'stdin',
    reviewAttribution: {},
    desktopNotifications: true,
  });
});

test('version 6 accepts Bitbucket Cloud accounts and uses the stable account UUID key', () => {
  const bitbucket = {
    accountId: '{123e4567-e89b-42d3-a456-426614174000}',
    credentialUsername: 'reviewer@example.com',
    repositories: ['workspace/repo'],
  };
  const config = validateConfig({
    ...validConfig,
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [bitbucket],
    aiProcessingConsent: createAiProcessingConsent(
      CODEX_REVIEWER_COMMAND,
      [{ ...bitbucket, hostname: 'bitbucket.org' }],
    ),
  });
  assert.equal(accountKey(config.bitbucketAccounts[0]), `bitbucket.org@${bitbucket.accountId}`);
  assert.equal(accountLabel(config.bitbucketAccounts[0]), 'reviewer@example.com@bitbucket.org');
  assert.equal(hasAiProcessingConsent(config), true);

  for (const unsafe of [
    'reviewer\u001b[31m@example.com',
    'reviewer\u202e@example.com',
    'reviewer\u200b@example.com',
  ]) {
    assert.throws(() => validateConfig({
      ...validConfig,
      configVersion: 6,
      githubAccounts: [],
      bitbucketAccounts: [{ ...bitbucket, credentialUsername: unsafe }],
    }), /credentialUsername is invalid/u);
  }
});

test('Bitbucket Cloud config survives normalized save and strict reload without derived fields', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-bitbucket-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  const bitbucket = {
    accountId: '{123e4567-e89b-42d3-a456-426614174000}',
    credentialUsername: 'reviewer@example.com',
    repositories: ['workspace/repo'],
  };
  const normalized = validateConfig({
    ...validConfig,
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [bitbucket],
    aiProcessingConsent: createAiProcessingConsent(
      CODEX_REVIEWER_COMMAND,
      [{ ...bitbucket, hostname: 'bitbucket.org' }],
    ),
  });

  const saved = await saveConfig(configPath, normalized);
  const persisted = JSON.parse(await readFile(configPath, 'utf8'));
  const reloaded = await loadConfig(configPath);

  assert.deepEqual(saved, normalized);
  assert.equal(persisted.bitbucketAccounts[0].hostname, undefined);
  assert.deepEqual(reloaded, normalized);
  assert.throws(
    () => validateConfig({
      ...persisted,
      bitbucketAccounts: [{ ...persisted.bitbucketAccounts[0], hostname: 'bitbucket.org' }],
    }),
    /unsupported field "hostname"/u,
  );
});

test('Bitbucket fails closed for custom reviewer commands without a prompt-only contract', () => {
  assert.throws(
    () => validateConfig({
      ...validConfig,
      configVersion: 6,
      bitbucketAccounts: [{
        accountId: '{123e4567-e89b-42d3-a456-426614174000}',
        credentialUsername: 'reviewer@example.com',
        repositories: ['workspace/repo'],
      }],
      reviewerCommand: 'reviewer --mcp {{mcp_config}} --tool {{mcp_tool}}',
    }),
    /generated Codex or Claude/u,
  );
});

test('accepts a manual reviewer timeout and defaults omitted values', () => {
  assert.equal(
    validateConfig({ ...validConfig, reviewTimeoutMs: 15 * 60 * 1000 }).reviewTimeoutMs,
    15 * 60 * 1000,
  );
  assert.equal(
    validateConfig({ ...validConfig, reviewTimeoutMs: undefined }).reviewTimeoutMs,
    DEFAULT_REVIEW_TIMEOUT_MS,
  );
});

test('rejects reviewer timeouts outside the bounded manual range', () => {
  for (const reviewTimeoutMs of [
    MIN_REVIEW_TIMEOUT_MS - 1,
    MAX_REVIEW_TIMEOUT_MS + 1,
    12.5 * 60 * 1000 + 0.5,
    null,
    '1800000',
  ]) {
    assert.throws(
      () => validateConfig({ ...validConfig, reviewTimeoutMs }),
      /reviewTimeoutMs must be a whole number of milliseconds/,
    );
  }
});

test('upgrades only the legacy Codex default command', () => {
  assert.equal(
    validateConfig({ ...validConfig, reviewerCommand: ' codex exec ' }).reviewerCommand,
    CODEX_REVIEWER_COMMAND,
  );
  assert.equal(
    validateConfig({
      ...validConfig,
      reviewerCommand: PREVIOUS_CODEX_REVIEWER_COMMAND,
    }).reviewerCommand,
    CODEX_REVIEWER_COMMAND,
  );
  assert.equal(
    validateConfig({
      ...validConfig,
      reviewerCommand: PR_LINK_CODEX_REVIEWER_COMMAND,
    }).reviewerCommand,
    CODEX_REVIEWER_COMMAND,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      reviewerCommand: 'codex exec --model custom',
    }),
    /reviewerCommand cannot inspect linked PRs safely/,
  );
  assert.equal(
    validateConfig({
      ...validConfig,
      reviewerCommand:
        'custom-reviewer --mcp {{mcp_config}} --allowed-tool {{mcp_tool}}',
    }).reviewerCommand,
    'custom-reviewer --mcp {{mcp_config}} --allowed-tool {{mcp_tool}}',
  );
});

test('the bundled manual config has a usable reviewer command', async () => {
  const example = JSON.parse(
    await readFile(path.join(projectRoot, 'config.example.json'), 'utf8'),
  );
  const config = validateConfig(example);
  assert.equal(config.reviewerCommand, CLAUDE_REVIEWER_COMMAND);
  assert.match(
    reviewerCommandForGitHubGateway(config.reviewerCommand, {
      mcpConfigPath: '/tmp/review/mcp.json',
      mcpServerPath: '/tmp/review/server.mjs',
    }),
    /--mcp-config "\/tmp\/review\/mcp\.json".*mcp__openmergelens__inspect_github_pr/,
  );
});

test('the generated Codex command grants no direct GitHub network access', () => {
  assert.equal(
    reviewerCommandForGitHubHost(CODEX_REVIEWER_COMMAND, 'github.com'),
    CODEX_REVIEWER_COMMAND,
  );
  assert.equal(
    reviewerCommandForGitHubHost(CODEX_REVIEWER_COMMAND, 'git.example.com'),
    CODEX_REVIEWER_COMMAND,
  );
  assert.doesNotMatch(CODEX_REVIEWER_COMMAND, /network\.domains/);
  assert.doesNotMatch(CODEX_REVIEWER_COMMAND, /network\.enabled/);
  assert.match(CODEX_REVIEWER_COMMAND, /":root"="deny"/);
  assert.match(CODEX_REVIEWER_COMMAND, /":minimal"="read"/);
  assert.match(CODEX_REVIEWER_COMMAND, /":workspace_roots"=\{"\."="read"\}/);
  assert.match(
    reviewerCommandForGitHubGateway(
      CODEX_REVIEWER_COMMAND,
      { mcpServerPath: '/tmp/review/github-mcp-server.mjs' },
    ),
    /mcp_servers\.openmergelens.*github-mcp-server\.mjs.*enabled_tools=.*inspect_github_pr/,
  );
  assert.match(
    reviewerCommandForGitHubGateway(
      CODEX_REVIEWER_COMMAND,
      { mcpServerPath: '/tmp/review/github-mcp-server.mjs' },
    ),
    /tools\.inspect_github_pr\.approval_mode="approve"/,
  );
  assert.equal(
    reviewerCommandForGitHubHost('custom-reviewer', 'git.example.com'),
    'custom-reviewer',
  );
});

test('the generated Codex command preserves quoted and escaped MCP server paths', () => {
  const paths = [
    '/tmp/O\'Reilly/server.mjs',
    "/tmp/O' Reilly/server.mjs",
    '/tmp/review\\ with-spaces/server.mjs',
    'C:\\Users\\Review User\\',
    '/tmp/review"quoted/server.mjs',
  ];

  for (const mcpServerPath of paths) {
    const command = reviewerCommandForGitHubGateway(
      CODEX_REVIEWER_COMMAND,
      { mcpServerPath },
    );
    const parsed = parseCommand(command);
    const argsConfig = parsed.args.find((arg) =>
      arg.startsWith('mcp_servers.openmergelens.args='));
    assert.ok(argsConfig, mcpServerPath);
    assert.deepEqual(
      JSON.parse(argsConfig.slice('mcp_servers.openmergelens.args='.length)),
      [mcpServerPath],
      mcpServerPath,
    );
  }
});

test('model settings are normalized independently and translated safely', () => {
  const modelConfig = {
    id: 'gpt-5.6',
    reasoningEffort: 'xhigh',
  };
  assert.deepEqual(
    validateConfig({ ...validConfig, model: modelConfig }).model,
    modelConfig,
  );
  assert.deepEqual(
    validateConfig({
      ...validConfig,
      model: { id: null, reasoningEffort: 'high' },
    }).model,
    { id: null, reasoningEffort: 'high' },
  );
  assert.equal(
    validateConfig({ ...validConfig, model: { id: null, reasoningEffort: null } }).model,
    null,
  );

  const codexCommand = reviewerCommandForModel(CODEX_REVIEWER_COMMAND, modelConfig);
  assert.deepEqual(parseCommand(codexCommand).args.slice(-4), [
    '--model',
    'gpt-5.6',
    '-c',
    'model_reasoning_effort="xhigh"',
  ]);
  const claudeCommand = reviewerCommandForModel(
    CLAUDE_REVIEWER_COMMAND,
    { id: 'opus', reasoningEffort: 'high' },
  );
  assert.deepEqual(parseCommand(claudeCommand).args.slice(-4), [
    '--model',
    'opus',
    '--effort',
    'high',
  ]);
  const gatewayCommand = reviewerCommandForGitHubGateway(
    CODEX_REVIEWER_COMMAND,
    { mcpServerPath: '/tmp/review/github-mcp-server.mjs' },
    modelConfig,
  );
  assert.deepEqual(parseCommand(gatewayCommand).args.slice(-4), [
    '--model',
    'gpt-5.6',
    '-c',
    'model_reasoning_effort="xhigh"',
  ]);
});

test('custom commands cannot carry generated model settings', () => {
  assert.equal(
    validateConfig({
      ...validConfig,
      reviewerCommand: 'custom --mcp {{mcp_config}} --tool {{mcp_tool}}',
      model: null,
    }).model,
    null,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      reviewerCommand: 'custom --mcp {{mcp_config}} --tool {{mcp_tool}}',
      model: { id: 'gpt-5.6', reasoningEffort: null },
    }),
    /model settings require the generated Codex or Claude reviewer command/,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      model: { id: 'bad model', reasoningEffort: null },
    }),
    /safe model ID/,
  );
});

test('version 3 configs migrate to the current schema with CLI defaults', () => {
  const migrated = validateConfig({
    ...validConfig,
    configVersion: 3,
  });
  assert.equal(migrated.configVersion, 6);
  assert.equal(migrated.model, null);
});

test('version 4 configs migrate to the current schema with timeout defaults', () => {
  const migrated = validateConfig({
    ...validConfig,
    configVersion: 4,
  });
  assert.equal(migrated.configVersion, 6);
  assert.equal(migrated.reviewTimeoutMs, DEFAULT_REVIEW_TIMEOUT_MS);
  assert.equal(
    validateConfig({
      ...validConfig,
      configVersion: 4,
      reviewTimeoutMs: 15 * 60 * 1000,
    }).reviewTimeoutMs,
    15 * 60 * 1000,
  );
});

test('custom reviewer commands must explicitly consume the per-review MCP contract', () => {
  const gateway = {
    mcpConfigPath: '/tmp/review with spaces/mcp.json',
    mcpServerPath: '/tmp/review/server.mjs',
  };
  assert.equal(
    reviewerCommandForGitHubGateway(
      'agent --mcp-config "{{mcp_config}}" --allowed-tool "{{mcp_tool}}"',
      gateway,
    ),
    'agent --mcp-config "/tmp/review with spaces/mcp.json" ' +
      '--allowed-tool "mcp__openmergelens__inspect_github_pr"',
  );
  const windowsCommand = reviewerCommandForGitHubGateway(
    'agent --mcp-config={{mcp_config}} --allowed-tool={{mcp_tool}}',
    {
      ...gateway,
      mcpConfigPath: 'C:\\Users\\Review User\\mcp.json',
    },
  );
  assert.equal(
    windowsCommand,
    'agent --mcp-config="C:\\Users\\Review User\\mcp.json" ' +
      '--allowed-tool="mcp__openmergelens__inspect_github_pr"',
  );
  assert.deepEqual(parseCommand(windowsCommand), {
    cmd: 'agent',
    args: [
      '--mcp-config=C:\\Users\\Review User\\mcp.json',
      '--allowed-tool=mcp__openmergelens__inspect_github_pr',
    ],
  });
  const claudeWindowsCommand = reviewerCommandForGitHubGateway(
    CLAUDE_REVIEWER_COMMAND,
    {
      ...gateway,
      mcpConfigPath: 'C:\\Users\\Review User\\mcp.json',
    },
  );
  const claudeWindowsArgs = parseCommand(claudeWindowsCommand).args;
  assert.equal(
    claudeWindowsArgs[claudeWindowsArgs.indexOf('--mcp-config') + 1],
    'C:\\Users\\Review User\\mcp.json',
  );
  assert.throws(
    () => reviewerCommandForGitHubGateway(
      'agent --mcp {{mcp_config}} --tool {{mcp_tool}}',
      { ...gateway, mcpConfigPath: '/tmp/unsafe"name/mcp.json' },
    ),
    /MCP config path cannot be represented safely/,
  );
  assert.throws(
    () => reviewerCommandForGitHubGateway('agent --review', gateway),
    /custom reviewerCommand cannot inspect linked PRs safely.*mcp_config.*mcp_tool/,
  );
});

test('rejects legacy, global, empty, and duplicate account shapes', () => {
  assert.throws(
    () => validateConfig({ githubAccount: {} }),
    /unsupported field "githubAccount"/,
  );
  assert.throws(
    () => validateConfig({ ...validConfig, configVersion: 1 }),
    /configVersion 6/,
  );
  assert.throws(
    () => validateConfig({ ...validConfig, searchScope: 'global' }),
    /unsupported field "searchScope"/,
  );
  assert.throws(
    () => validateConfig({ ...validConfig, githubAccounts: [] }),
    /at least one GitHub or Bitbucket account/,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [
        validConfig.githubAccounts[0],
        {
          hostname: 'GitHub.com',
          username: 'WORK-USER',
          repositories: ['owner/repo'],
        },
      ],
    }),
    /duplicate GitHub account/,
  );
});

test('supports managed-user underscores while rejecting unknown account fields', () => {
  const managed = validateConfig({
    ...validConfig,
    githubAccounts: [{
      hostname: 'example.ghe.com',
      username: 'shortcode_admin',
      repositories: ['shortcode_admin/repo'],
    }],
  });
  assert.equal(managed.githubAccounts[0].username, 'shortcode_admin');
  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [{
        hostname: 'github.com',
        username: 'octocat',
        repositories: ['owner/repo'],
        learningsPath: './shared.md',
      }],
    }),
    /unsupported field "learningsPath"/,
  );
});

test('requires explicit, unique repositories for every account', () => {
  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [{ hostname: 'github.com', username: 'octocat', repositories: [] }],
    }),
    /at least one repository/,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [{
        hostname: 'github.com',
        username: 'octocat',
        repositories: ['Owner/Repo', 'owner/repo'],
      }],
    }),
    /duplicate repository/,
  );
  for (const repository of ['owner', '../repo', 'owner/../repo', 'owner/repo/extra']) {
    assert.throws(
      () => validateConfig({
        ...validConfig,
        githubAccounts: [{
          hostname: 'github.com',
          username: 'octocat',
          repositories: [repository],
        }],
      }),
      /valid OWNER\/REPO/,
    );
  }
});

test('AI-processing consent is one explicit config-wide scoped record', () => {
  const withoutConsent = validateConfig({
    ...validConfig,
    aiProcessingConsent: undefined,
  });
  assert.equal(withoutConsent.aiProcessingConsent, null);

  assert.throws(
    () => validateConfig({
      ...validConfig,
      aiProcessingConsent: ['owner/repo'],
    }),
    /aiProcessingConsent must be a consent object/,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      githubAccounts: [{
        hostname: 'github.com',
        username: 'octocat',
        repositories: ['Owner/Repo'],
        aiProcessingConsent: true,
      }],
    }),
    /unsupported field "aiProcessingConsent"/,
  );
});

test('version 2 repository consent migrates fail closed to version 6', () => {
  const legacyConfig = {
    ...validConfig,
    configVersion: 2,
    aiProcessingConsent: undefined,
    githubAccounts: validConfig.githubAccounts.map((account) => ({
      ...account,
      aiProcessingConsent: [...account.repositories],
    })),
  };
  const fullyConsented = validateConfig(legacyConfig);
  assert.equal(fullyConsented.configVersion, 6);
  assert.equal(hasAiProcessingConsent(fullyConsented), true);
  assert.equal(
    Object.hasOwn(fullyConsented.githubAccounts[0], 'aiProcessingConsent'),
    false,
  );

  const partiallyConsented = validateConfig({
    ...legacyConfig,
    githubAccounts: legacyConfig.githubAccounts.map((account, index) => ({
      ...account,
      aiProcessingConsent: index === 0 ? account.repositories.slice(0, 1) : [],
    })),
  });
  assert.equal(partiallyConsented.aiProcessingConsent, null);

  const overbroadLegacyConsent = validateConfig({
    ...legacyConfig,
    githubAccounts: legacyConfig.githubAccounts.map((account, index) => ({
      ...account,
      aiProcessingConsent: index === 0
        ? [...account.repositories, 'other/repo']
        : account.repositories,
    })),
  });
  assert.equal(overbroadLegacyConsent.aiProcessingConsent, null);

  assert.throws(
    () => validateConfig({
      ...validConfig,
      configVersion: 2,
      aiProcessingConsent: undefined,
      githubAccounts: [{
        hostname: 'github.com',
        username: 'octocat',
        repositories: ['owner/repo'],
        aiProcessingConsent: ['not/a/valid/repository/path'],
      }],
    }),
    /valid OWNER\/REPO/,
  );
});

test('desktop notifications default on and require a boolean opt-out', () => {
  assert.equal(validateConfig(validConfig).desktopNotifications, true);
  assert.equal(
    validateConfig({ ...validConfig, desktopNotifications: false }).desktopNotifications,
    false,
  );
  assert.throws(
    () => validateConfig({ ...validConfig, desktopNotifications: 'false' }),
    /desktopNotifications must be true or false/,
  );
});

test('review attribution defaults on and supports validated per-repository overrides', () => {
  const config = validateConfig(validConfig);
  const account = config.githubAccounts[0];
  assert.equal(reviewAttributionKey(account, 'Company/API'), 'github.com/Company/API');
  assert.equal(reviewAttributionEnabled(config, account, 'Company/API'), true);

  const disabled = validateConfig({
    ...validConfig,
    reviewAttribution: { 'GITHUB.COM/company/api': false },
  });
  assert.deepEqual(disabled.reviewAttribution, { 'github.com/Company/API': false });
  assert.equal(reviewAttributionEnabled(disabled, account, 'Company/API'), false);
  assert.equal(reviewAttributionEnabled(disabled, account, 'Company/web'), true);
  const bitbucketAccount = {
    accountId: '{123e4567-e89b-42d3-a456-426614174000}',
    credentialUsername: 'reviewer@example.com',
    repositories: ['Workspace/Repo'],
  };
  const bitbucketConfig = validateConfig({
    ...validConfig,
    configVersion: 6,
    githubAccounts: [],
    bitbucketAccounts: [bitbucketAccount],
    aiProcessingConsent: null,
    reviewAttribution: { 'BITBUCKET.ORG/workspace/repo': false },
  });
  assert.deepEqual(bitbucketConfig.reviewAttribution, {
    'bitbucket.org/Workspace/Repo': false,
  });
  assert.equal(
    reviewAttributionEnabled(bitbucketConfig, bitbucketConfig.bitbucketAccounts[0], 'Workspace/Repo'),
    false,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      reviewAttribution: null,
    }),
    /reviewAttribution must be an object/u,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      reviewAttribution: { 'github.com/Company/API': 'false' },
    }),
    /reviewAttribution.*must be true or false/u,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      reviewAttribution: { 'github.com/other/repo': false },
    }),
    /unconfigured repository/u,
  );
  assert.throws(
    () => validateConfig({
      ...validConfig,
      reviewAttribution: {
        'github.com/Company/API': false,
        'GITHUB.COM/company/api': true,
      },
    }),
    /duplicate repository/u,
  );
});

test('account keys are host-aware while labels and selectors are user-facing', () => {
  const account = { hostname: 'GitHub.com', username: 'OctoCat' };
  assert.equal(accountKey(account), 'github.com@octocat');
  assert.equal(accountLabel(account), 'OctoCat@github.com');
  assert.deepEqual(parseAccountSelector('OctoCat@GitHub.com'), {
    username: 'OctoCat',
    hostname: 'github.com',
  });
  assert.throws(() => parseAccountSelector('octocat'), /USERNAME@HOSTNAME/);
});

test('config saves atomically and reloads through the same validation boundary', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'nested', 'config.json');

  const normalized = await saveConfig(configPath, validConfig);
  assert.deepEqual(await loadConfig(configPath), normalized);
  const replaced = await saveConfig(configPath, {
    ...validConfig,
    reviewerCommand: CLAUDE_REVIEWER_COMMAND,
  });
  assert.deepEqual(await loadConfig(configPath), replaced);
  assert.deepEqual(await readdir(path.dirname(configPath)), ['config.json']);
});

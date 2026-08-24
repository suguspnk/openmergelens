import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveReviewBatchSize } from './poll-batching.mjs';
import {
  resolveReviewFocusCount,
  resolveReviewTimeoutMs,
} from './reviewer-adapter.mjs';
import {
  reviewerBackendForCommand,
  validateReviewerCommandContract,
} from './reviewer-command-defaults.mjs';
import {
  normalizeReviewerModel,
} from './reviewer-models.mjs';
import {
  createAiProcessingConsent,
  normalizeAiProcessingConsent,
} from './ai-processing-consent.mjs';
import {
  enforcePrivateMode,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';

export const CONFIG_VERSION = 6;
const GITHUB_ONLY_CONFIG_VERSION = 5;
const PREVIOUS_CONFIG_VERSION = 4;
const MODEL_CONFIG_VERSION = 3;
const LEGACY_CONFIG_VERSION = 2;

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)*(?<!-)$/i;
const ACCOUNT_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,38})$/i;
// Bitbucket Cloud workspaces may be up to 62 characters. Keep this separate
// from GitHub's owner validator so accepting Bitbucket names cannot broaden
// the GitHub configuration or state namespace.
const BITBUCKET_WORKSPACE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,61})$/i;
const REPOSITORY_SEGMENT_PATTERN = /^[a-z0-9._-]+$/i;
const CONFIG_FIELDS = new Set([
  'configVersion',
  'githubAccounts',
  'bitbucketAccounts',
  'aiProcessingConsent',
  'reviewerCommand',
  'model',
  'reviewerInputMode',
  'reviewBatchSize',
  'reviewFocusCount',
  'reviewTimeoutMs',
  'reviewAttribution',
  'desktopNotifications',
  'stateFile',
]);
const ACCOUNT_FIELDS = new Set([
  'hostname',
  'username',
  'repositories',
]);
const BITBUCKET_ACCOUNT_FIELDS = new Set([
  'accountId',
  'credentialUsername',
  'repositories',
]);
const NORMALIZED_BITBUCKET_ACCOUNT_FIELDS = new Set([
  ...BITBUCKET_ACCOUNT_FIELDS,
  'hostname',
]);
const BITBUCKET_ACCOUNT_ID_PATTERN = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/i;
const UNSAFE_BITBUCKET_CREDENTIAL_USERNAME_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function migrateLegacyConfig(input) {
  if (input.configVersion === GITHUB_ONLY_CONFIG_VERSION) {
    return {
      input: {
        ...input,
        configVersion: CONFIG_VERSION,
        bitbucketAccounts: [],
      },
      legacyConsentGranted: false,
    };
  }
  if (
    input.configVersion === PREVIOUS_CONFIG_VERSION ||
    input.configVersion === MODEL_CONFIG_VERSION
  ) {
    return {
      input: {
        ...input,
        configVersion: CONFIG_VERSION,
        bitbucketAccounts: [],
      },
      legacyConsentGranted: false,
    };
  }

  if (input.configVersion !== LEGACY_CONFIG_VERSION) {
    return { input, legacyConsentGranted: false };
  }

  const githubAccounts = Array.isArray(input.githubAccounts)
    ? input.githubAccounts.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return candidate;
      }
      const { aiProcessingConsent: _legacyConsent, ...account } = candidate;
      return account;
    })
    : input.githubAccounts;
  let legacyConsentGranted = false;
  if (Array.isArray(input.githubAccounts) && input.githubAccounts.length > 0) {
    legacyConsentGranted = input.githubAccounts.every((account) => {
      if (
        !Array.isArray(account?.repositories) ||
        !Array.isArray(account?.aiProcessingConsent)
      ) {
        return false;
      }
      const consented = new Set(
        account.aiProcessingConsent.map((repository) =>
          normalizeRepository(repository).toLowerCase(),
        ),
      );
      const selected = new Set(
        account.repositories.map((repository) =>
          normalizeRepository(repository).toLowerCase(),
        ),
      );
      return consented.size === account.aiProcessingConsent.length &&
        consented.size === selected.size &&
        [...selected].every((repository) => consented.has(repository));
    });
  }

  return {
    input: {
      ...input,
      configVersion: CONFIG_VERSION,
      githubAccounts,
      bitbucketAccounts: [],
      aiProcessingConsent: undefined,
    },
    legacyConsentGranted,
  };
}

function rejectUnknownFields(value, allowed, context) {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new Error(`${context} contains unsupported field "${unknown}"`);
}

export function normalizeGitHubAccount(account) {
  const hostname = account?.hostname?.trim().toLowerCase();
  const username = account?.username?.trim();

  if (!hostname || !HOSTNAME_PATTERN.test(hostname)) {
    throw new Error('GitHub account hostname is invalid');
  }
  if (!username || !ACCOUNT_SEGMENT_PATTERN.test(username)) {
    throw new Error('GitHub account username is invalid');
  }

  return { hostname, username };
}

export function normalizeBitbucketAccount(account) {
  const accountId = account?.accountId?.trim().toLowerCase();
  const credentialUsername = account?.credentialUsername?.trim();
  if (!accountId || !BITBUCKET_ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error('Bitbucket accountId must be the account UUID returned by /2.0/user');
  }
  if (
    !credentialUsername ||
    credentialUsername.length > 254 ||
    UNSAFE_BITBUCKET_CREDENTIAL_USERNAME_PATTERN.test(credentialUsername)
  ) {
    throw new Error('Bitbucket credentialUsername is invalid');
  }
  return {
    hostname: 'bitbucket.org',
    accountId,
    credentialUsername,
  };
}

export function accountProvider(account) {
  return account?.accountId === undefined ? 'github' : 'bitbucket';
}

export function accountKey(account) {
  if (accountProvider(account) === 'bitbucket') {
    return `bitbucket.org@${normalizeBitbucketAccount(account).accountId}`;
  }
  const { hostname, username } = normalizeGitHubAccount(account);
  return `${hostname}@${username.toLowerCase()}`;
}

export function accountLabel(account) {
  if (accountProvider(account) === 'bitbucket') {
    const normalized = normalizeBitbucketAccount(account);
    return `${normalized.credentialUsername}@bitbucket.org`;
  }
  const { hostname, username } = normalizeGitHubAccount(account);
  return `${username}@${hostname}`;
}

export function normalizeRepository(repository) {
  if (typeof repository !== 'string') {
    throw new Error('GitHub repository must be an OWNER/REPO string');
  }

  const trimmed = repository.trim();
  const parts = trimmed.split('/');
  if (
    parts.length !== 2 ||
    !ACCOUNT_SEGMENT_PATTERN.test(parts[0]) ||
    !REPOSITORY_SEGMENT_PATTERN.test(parts[1]) ||
    parts[1].length > 100 ||
    parts[1] === '.' ||
    parts[1] === '..'
  ) {
    throw new Error(`GitHub repository "${repository}" must be a valid OWNER/REPO`);
  }

  return trimmed;
}

export function normalizeBitbucketRepository(repository) {
  if (typeof repository !== 'string') {
    throw new Error('Bitbucket repository must be a WORKSPACE/REPO string');
  }
  const trimmed = repository.trim();
  const parts = trimmed.split('/');
  let workspaceIsCanonical = false;
  if (parts.length === 2) {
    try {
      workspaceIsCanonical = normalizeBitbucketWorkspace(parts[0]) === parts[0];
    } catch {
      workspaceIsCanonical = false;
    }
  }
  if (
    parts.length !== 2 ||
    !workspaceIsCanonical ||
    !REPOSITORY_SEGMENT_PATTERN.test(parts[1]) ||
    parts[1].length > 100 ||
    parts[1] === '.' ||
    parts[1] === '..'
  ) {
    throw new Error(`Bitbucket repository "${repository}" must be a valid WORKSPACE/REPO`);
  }
  return trimmed;
}

export function normalizeBitbucketWorkspace(workspace) {
  if (typeof workspace !== 'string') {
    throw new Error('Bitbucket workspace must be a string');
  }
  const trimmed = workspace.trim();
  if (!BITBUCKET_WORKSPACE_PATTERN.test(trimmed)) {
    throw new Error(`Bitbucket workspace "${workspace}" is invalid`);
  }
  return trimmed;
}

export function parseAccountSelector(selector) {
  if (typeof selector !== 'string') {
    throw new Error('account selector must be USERNAME@HOSTNAME');
  }
  const separator = selector.lastIndexOf('@');
  if (separator <= 0) {
    throw new Error(`account selector "${selector}" must be USERNAME@HOSTNAME`);
  }
  const username = selector.slice(0, separator).trim();
  const hostname = selector.slice(separator + 1).trim().toLowerCase();
  if (
    !username || username.length > 254 || /[\0\r\n]/u.test(username) ||
    !hostname || !HOSTNAME_PATTERN.test(hostname)
  ) {
    throw new Error(`account selector "${selector}" must be USERNAME@HOSTNAME`);
  }
  return { username, hostname };
}

function validateConfigInput(input, { allowNormalizedBitbucketAccounts = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config.json must contain a JSON object');
  }
  const migration = migrateLegacyConfig(input);
  input = migration.input;
  rejectUnknownFields(input, CONFIG_FIELDS, 'config.json');
  if (input.configVersion !== CONFIG_VERSION) {
    throw new Error(
      `config.json must use configVersion ${CONFIG_VERSION}; run \`openmergelens init\``,
    );
  }
  if (!Array.isArray(input.githubAccounts)) {
    throw new Error('config.json githubAccounts must be an array');
  }
  if (!Array.isArray(input.bitbucketAccounts)) {
    throw new Error('config.json bitbucketAccounts must be an array');
  }
  if (input.githubAccounts.length === 0 && input.bitbucketAccounts.length === 0) {
    throw new Error('config.json must contain at least one GitHub or Bitbucket account');
  }
  if (typeof input.reviewerCommand !== 'string' || !input.reviewerCommand.trim()) {
    throw new Error('config.json reviewerCommand must be a non-empty string');
  }
  if (
    input.reviewerInputMode !== undefined &&
    input.reviewerInputMode !== 'stdin'
  ) {
    throw new Error('config.json reviewerInputMode must be "stdin"');
  }
  if (
    input.stateFile !== undefined &&
    (typeof input.stateFile !== 'string' || !input.stateFile.trim())
  ) {
    throw new Error('config.json stateFile must be a non-empty string');
  }
  if (
    input.desktopNotifications !== undefined &&
    typeof input.desktopNotifications !== 'boolean'
  ) {
    throw new Error('config.json desktopNotifications must be true or false');
  }
  const seenAccounts = new Set();
  const githubAccounts = input.githubAccounts.map((candidate, accountIndex) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`config.json githubAccounts[${accountIndex}] must be an object`);
    }
    rejectUnknownFields(
      candidate,
      ACCOUNT_FIELDS,
      `config.json githubAccounts[${accountIndex}]`,
    );
    const account = normalizeGitHubAccount(candidate);
    const key = accountKey(account);
    if (seenAccounts.has(key)) {
      throw new Error(`config.json contains duplicate GitHub account ${accountLabel(account)}`);
    }
    seenAccounts.add(key);

    if (!Array.isArray(candidate.repositories) || candidate.repositories.length === 0) {
      throw new Error(
        `config.json githubAccounts[${accountIndex}].repositories must contain at least one repository`,
      );
    }
    const seenRepositories = new Set();
    const repositories = candidate.repositories.map((repository) => {
      const normalized = normalizeRepository(repository);
      const repositoryKey = normalized.toLowerCase();
      if (seenRepositories.has(repositoryKey)) {
        throw new Error(
          `config.json account ${accountLabel(account)} contains duplicate repository ${normalized}`,
        );
      }
      seenRepositories.add(repositoryKey);
      return normalized;
    });

    return { ...account, repositories };
  });
  const bitbucketAccounts = input.bitbucketAccounts.map((candidate, accountIndex) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`config.json bitbucketAccounts[${accountIndex}] must be an object`);
    }
    rejectUnknownFields(
      candidate,
      allowNormalizedBitbucketAccounts
        ? NORMALIZED_BITBUCKET_ACCOUNT_FIELDS
        : BITBUCKET_ACCOUNT_FIELDS,
      `config.json bitbucketAccounts[${accountIndex}]`,
    );
    if (
      allowNormalizedBitbucketAccounts &&
      Object.prototype.hasOwnProperty.call(candidate, 'hostname') &&
      candidate.hostname !== 'bitbucket.org'
    ) {
      throw new Error(
        `config.json bitbucketAccounts[${accountIndex}].hostname must be "bitbucket.org"`,
      );
    }
    const account = normalizeBitbucketAccount(candidate);
    const key = accountKey(account);
    if (seenAccounts.has(key)) {
      throw new Error(`config.json contains duplicate Bitbucket account ${account.accountId}`);
    }
    seenAccounts.add(key);
    if (!Array.isArray(candidate.repositories) || candidate.repositories.length === 0) {
      throw new Error(
        `config.json bitbucketAccounts[${accountIndex}].repositories must contain at least one repository`,
      );
    }
    const seenRepositories = new Set();
    const repositories = candidate.repositories.map((repository) => {
      const normalized = normalizeBitbucketRepository(repository);
      const repositoryKey = normalized.toLowerCase();
      if (seenRepositories.has(repositoryKey)) {
        throw new Error(
          `config.json account ${accountLabel(account)} contains duplicate repository ${normalized}`,
        );
      }
      seenRepositories.add(repositoryKey);
      return normalized;
    });
    return { ...account, repositories };
  });

  const configuredRepositories = new Map();
  for (const account of [...githubAccounts, ...bitbucketAccounts]) {
    for (const repository of account.repositories) {
      const key = reviewAttributionKey(account, repository);
      configuredRepositories.set(key.toLowerCase(), key);
    }
  }
  if (
    input.reviewAttribution !== undefined &&
    (!input.reviewAttribution ||
      typeof input.reviewAttribution !== 'object' ||
      Array.isArray(input.reviewAttribution))
  ) {
    throw new Error('config.json reviewAttribution must be an object');
  }
  const reviewAttribution = {};
  const seenAttributionRepositories = new Set();
  for (const [suppliedKey, enabled] of Object.entries(input.reviewAttribution || {})) {
    if (typeof enabled !== 'boolean') {
      throw new Error(`config.json reviewAttribution["${suppliedKey}"] must be true or false`);
    }
    const canonicalKey = configuredRepositories.get(suppliedKey.toLowerCase());
    if (!canonicalKey) {
      throw new Error(
        `config.json reviewAttribution contains unconfigured repository "${suppliedKey}"`,
      );
    }
    const repositoryKey = canonicalKey.toLowerCase();
    if (seenAttributionRepositories.has(repositoryKey)) {
      throw new Error(
        `config.json reviewAttribution contains duplicate repository "${suppliedKey}"`,
      );
    }
    seenAttributionRepositories.add(repositoryKey);
    reviewAttribution[canonicalKey] = enabled;
  }

  const reviewerCommand = validateReviewerCommandContract(input.reviewerCommand);
  const reviewerBackend = reviewerBackendForCommand(reviewerCommand);
  if (bitbucketAccounts.length > 0 && !reviewerBackend) {
    throw new Error(
      'config.json Bitbucket accounts require the generated Codex or Claude reviewer command',
    );
  }
  if (input.model !== undefined && input.model !== null && !reviewerBackend) {
    throw new Error(
      'config.json model settings require the generated Codex or Claude reviewer command',
    );
  }
  const model = normalizeReviewerModel(input.model, {
    backend: reviewerBackend,
  });
  const aiProcessingConsent = migration.legacyConsentGranted
    ? createAiProcessingConsent(reviewerCommand, githubAccounts)
    : normalizeAiProcessingConsent(input.aiProcessingConsent);

  return {
    configVersion: CONFIG_VERSION,
    githubAccounts,
    bitbucketAccounts,
    aiProcessingConsent,
    reviewerCommand,
    model,
    reviewerInputMode: 'stdin',
    reviewBatchSize: resolveReviewBatchSize(input.reviewBatchSize),
    reviewFocusCount: resolveReviewFocusCount(input.reviewFocusCount),
    reviewTimeoutMs: resolveReviewTimeoutMs(input.reviewTimeoutMs),
    reviewAttribution,
    desktopNotifications: input.desktopNotifications !== false,
    stateFile: input.stateFile?.trim() || './state.json',
  };
}

export function reviewAttributionKey(account, repository) {
  const hostname = accountProvider(account) === 'bitbucket'
    ? 'bitbucket.org'
    : normalizeGitHubAccount(account).hostname;
  const normalizedRepository = accountProvider(account) === 'bitbucket'
    ? normalizeBitbucketRepository(repository)
    : normalizeRepository(repository);
  return `${hostname}/${normalizedRepository}`;
}

export function reviewAttributionEnabled(config, account, repository) {
  const key = reviewAttributionKey(account, repository);
  return config?.reviewAttribution?.[key] !== false;
}

export function retainReviewAttribution(reviewAttribution, accounts) {
  if (reviewAttribution === undefined) return undefined;
  if (
    !reviewAttribution ||
    typeof reviewAttribution !== 'object' ||
    Array.isArray(reviewAttribution)
  ) {
    return reviewAttribution;
  }
  const configuredRepositories = new Map();
  for (const account of accounts) {
    for (const repository of account.repositories || []) {
      const key = reviewAttributionKey(account, repository);
      configuredRepositories.set(key.toLowerCase(), key);
    }
  }
  const retained = {};
  for (const [suppliedKey, enabled] of Object.entries(reviewAttribution || {})) {
    const canonicalKey = configuredRepositories.get(suppliedKey.toLowerCase());
    if (canonicalKey) retained[canonicalKey] = enabled;
  }
  return retained;
}

export function validateConfig(input) {
  return validateConfigInput(input);
}

export function validateNormalizedConfig(input) {
  return validateConfigInput(input, { allowNormalizedBitbucketAccounts: true });
}

export async function loadConfig(configPath) {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
    await enforcePrivateMode(configPath, PRIVATE_FILE_MODE);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`no config found at ${configPath}; run \`openmergelens init\` first`);
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }
  return validateConfig(parsed);
}

export async function saveConfig(configPath, input) {
  const config = validateNormalizedConfig(input);
  const persistedConfig = {
    ...config,
    bitbucketAccounts: config.bitbucketAccounts.map(({ hostname: _hostname, ...account }) =>
      account),
  };
  await ensurePrivateDirectory(path.dirname(configPath));
  const temporaryPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporaryPath,
      JSON.stringify(persistedConfig, null, 2) + '\n',
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: PRIVATE_FILE_MODE,
      },
    );
    await rename(temporaryPath, configPath);
    await enforcePrivateMode(configPath, PRIVATE_FILE_MODE);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return config;
}

import * as p from '@clack/prompts';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentUsername, listAccessibleRepos } from './github.mjs';
import {
  createAiProcessingConsent,
  retainAiProcessingConsent,
} from './ai-processing-consent.mjs';
import {
  accountKey,
  accountLabel,
  loadConfig,
  saveConfig,
  validateNormalizedConfig,
} from './config.mjs';
import {
  listAuthenticatedAccounts,
  resolveGitHubAuth,
} from './github-auth.mjs';
import { detectAgents } from './agent-detect.mjs';
import { ensurePrivateDirectory } from './file-security.mjs';
import { ensureLearningsFile, learningsPathFor } from './learnings.mjs';
import { acquireLock } from './lock.mjs';
import { isValidReviewBatchSize } from './poll-batching.mjs';
import { userHome, userPath } from './paths.mjs';
import {
  ensureReviewPrompt,
  reviewPromptPathFor,
} from './review-prompts.mjs';
import {
  reviewerBackendForCommand,
  validateReviewerCommandContract,
} from './reviewer-command-defaults.mjs';
import { describeReviewerModel } from './reviewer-models.mjs';
import {
  isValidReviewFocusCount,
  isValidReviewTimeoutMs,
  MAX_REVIEW_TIMEOUT_MS,
  MIN_REVIEW_TIMEOUT_MS,
} from './reviewer-adapter.mjs';
import {
  cronPreview,
  installCron,
  installLaunchd,
  installSchtasks,
  launchdPreview,
  manualInstructions,
  schtasksPreview,
  schedulerChoices,
  SUPPORTED_CRON_INTERVALS,
} from './scheduler.mjs';
import {
  applyScheduleSelection,
  canonicalRepositorySelections,
  isInteractiveTerminal,
  recheckReviewerAgent,
  reviewerBackendOptions,
  selectReviewerModel,
  verifyConfiguredNotifications,
  validateScheduleInterval,
} from './setup-interactive.mjs';

const packageRootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const configPath = userPath('config.json');
const pollScriptPath = path.join(packageRootDir, 'bin', 'poll.mjs');
const reviewPromptTemplatePath = path.join(
  packageRootDir,
  'docs',
  'review-prompt.default.md',
);
const EDIT_CANCELLED = Symbol('config edit cancelled');

const REVIEWER_LABELS = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex CLI',
});

function repositoryCount(config) {
  return [...config.githubAccounts, ...(config.bitbucketAccounts || [])].reduce(
    (total, account) => total + account.repositories.length,
    0,
  );
}

function accountSummary(config) {
  const accountCount = config.githubAccounts.length + (config.bitbucketAccounts?.length || 0);
  const repoCount = repositoryCount(config);
  return `${accountCount} account(s), ${repoCount} repository(s)`;
}

function reviewerSummary(config) {
  const backend = reviewerBackendForCommand(config.reviewerCommand);
  const backendLabel = backend ? REVIEWER_LABELS[backend] : 'Custom command';
  return `${backendLabel}; ${describeReviewerModel(config.model)}`;
}

function notificationsSummary(config) {
  return config.desktopNotifications ? 'enabled' : 'disabled';
}

export function configMenuOptions(config) {
  return [
    {
      value: 'accounts',
      label: 'Accounts & repositories',
      hint: accountSummary(config),
    },
    {
      value: 'reviewer',
      label: 'Reviewer backend & model',
      hint: reviewerSummary(config),
    },
    {
      value: 'review',
      label: 'Review behavior',
      hint: `batch ${config.reviewBatchSize}; ${config.reviewFocusCount} focus categories; timeout ${config.reviewTimeoutMs}ms`,
    },
    {
      value: 'notifications',
      label: 'Desktop notifications',
      hint: notificationsSummary(config),
    },
    {
      value: 'schedule',
      label: 'Schedule',
      hint: 'managed outside config.json',
    },
    {
      value: 'view',
      label: 'View current configuration',
    },
    {
      value: 'exit',
      label: 'Exit',
    },
  ];
}

export function reviewBehaviorMenuOptions(config) {
  return [
    {
      value: 'batch-size',
      label: 'Review batch size',
      hint: String(config.reviewBatchSize),
    },
    {
      value: 'focus-count',
      label: 'Review focus categories',
      hint: String(config.reviewFocusCount),
    },
    {
      value: 'timeout',
      label: 'Reviewer process timeout',
      hint: `${config.reviewTimeoutMs} ms`,
    },
    {
      value: 'state-file',
      label: 'Review state file',
      hint: config.stateFile,
    },
    {
      value: 'back',
      label: 'Back',
    },
  ];
}

export async function persistConfigUpdate({
  configPath: targetPath,
  currentConfig,
  nextConfig,
  save = saveConfig,
}) {
  const normalized = validateNormalizedConfig(nextConfig);
  if (JSON.stringify(currentConfig) === JSON.stringify(normalized)) {
    return { config: currentConfig, changed: false };
  }
  return {
    config: await save(targetPath, normalized),
    changed: true,
  };
}

async function saveEditedConfig(currentConfig, nextConfig) {
  const result = await persistConfigUpdate({
    configPath,
    currentConfig,
    nextConfig,
  });
  if (result.changed) {
    p.log.success('Configuration saved');
  } else {
    p.log.info('No changes to save');
  }
  return result.config;
}

function throwEditCancelled() {
  throw EDIT_CANCELLED;
}

export function configLoadErrorMessage(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('run `openmergelens init`')
    ? message
    : `${message}; run \`openmergelens init\` first`;
}

function editorConfigLoadError(err) {
  const message = configLoadErrorMessage(err);
  if (err instanceof Error && err.message === message) return err;
  return new Error(message, { cause: err });
}

async function consentedConfigUpdate(currentConfig, nextConfig) {
  const retainedConsent = retainAiProcessingConsent(
    currentConfig.aiProcessingConsent,
    currentConfig.reviewerCommand,
    nextConfig.reviewerCommand,
    [...currentConfig.githubAccounts, ...(currentConfig.bitbucketAccounts || [])],
    [...nextConfig.githubAccounts, ...(nextConfig.bitbucketAccounts || [])],
  );
  if (retainedConsent) {
    return { ...nextConfig, aiProcessingConsent: retainedConsent };
  }

  const selectedRepositories = repositoryCount(nextConfig);
  p.log.warn(
    'The selected reviewer backend may send private source code, pull-request ' +
      'content, and personal data to its provider. Confirm that the repository ' +
      'owner permits this and that provider retention, training, confidentiality, ' +
      'data-residency, and DPA terms are acceptable.',
  );
  const consent = await p.confirm({
    message:
      `Authorize third-party AI processing for all ${selectedRepositories} selected ` +
      `repositories across ${nextConfig.githubAccounts.length + (nextConfig.bitbucketAccounts?.length || 0)} account(s)?`,
    initialValue: false,
  });
  if (p.isCancel(consent) || !consent) {
    p.log.warn('Update cancelled; the previous configuration remains active.');
    return null;
  }
  return {
    ...nextConfig,
    aiProcessingConsent: createAiProcessingConsent(
      nextConfig.reviewerCommand,
      [...nextConfig.githubAccounts, ...(nextConfig.bitbucketAccounts || [])],
    ),
  };
}

async function ensureConfigReviewFiles(accounts, createdFiles) {
  for (const account of accounts) {
    for (const repo of account.repositories) {
      const promptPath = reviewPromptPathFor(account.hostname, repo);
      const learningsPath = learningsPathFor(account, repo);
      for (const filePath of [promptPath, learningsPath]) {
        try {
          await access(filePath);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          createdFiles.push(filePath);
        }
      }
      await ensureReviewPrompt(account.hostname, repo, {
        templatePath: reviewPromptTemplatePath,
      });
      await ensureLearningsFile(account, repo);
    }
  }
}

async function editAccounts(currentConfig) {
  const authenticatedAccounts = await listAuthenticatedAccounts();
  if (authenticatedAccounts.length === 0) {
    throw new Error('GitHub CLI has no authenticated accounts; run `gh auth login`');
  }

  const existingByKey = new Map(
    currentConfig.githubAccounts.map((account) => [accountKey(account), account]),
  );
  const availableByKey = new Map(
    authenticatedAccounts.map((account) => [accountKey(account), account]),
  );
  const selectedAccountKeys = await p.autocompleteMultiselect({
    message: 'Which GitHub accounts should watch for review requests?',
    options: authenticatedAccounts.map((account) => ({
      value: accountKey(account),
      label: accountLabel(account),
      hint: account.active ? 'currently active in gh' : undefined,
    })),
    initialValues: authenticatedAccounts
      .filter((account) => existingByKey.has(accountKey(account)))
      .map(accountKey),
    required: true,
  });
  if (p.isCancel(selectedAccountKeys)) return currentConfig;

  const githubAccounts = [];
  for (const selectedKey of selectedAccountKeys) {
    const selected = availableByKey.get(selectedKey);
    if (!selected) throw new Error(`unknown authenticated account ${selectedKey}`);
    const auth = await resolveGitHubAuth(selected);
    const username = await currentUsername({ auth });
    if (username.toLowerCase() !== selected.username.toLowerCase()) {
      throw new Error(
        `Selected ${selected.username}, but its credential belongs to ${username}`,
      );
    }
    const account = { hostname: selected.hostname, username };
    p.log.success(`Authenticated ${accountLabel(account)}`);

    const spinner = p.spinner();
    spinner.start(`Fetching repositories for ${accountLabel(account)}`);
    let repos;
    try {
      repos = await listAccessibleRepos({ auth });
    } catch (err) {
      spinner.stop('Repository fetch failed');
      throw err;
    }
    spinner.stop(`Found ${repos.length} repository(s) for ${accountLabel(account)}`);
    if (repos.length === 0) {
      throw new Error(`${accountLabel(account)} has no accessible repositories`);
    }

    const existingRepositories = existingByKey.get(selectedKey)?.repositories || [];
    const repositories = await p.autocompleteMultiselect({
      message: `Which repositories should ${accountLabel(account)} watch for review requests?`,
      options: repos.map((repo) => ({
        value: repo.nameWithOwner,
        label: repo.nameWithOwner,
        hint: repo.isPrivate ? 'private' : undefined,
      })),
      initialValues: canonicalRepositorySelections(existingRepositories, repos),
      required: true,
    });
    if (p.isCancel(repositories)) return currentConfig;
    githubAccounts.push({ ...account, repositories });
  }

  const nextConfig = await consentedConfigUpdate(currentConfig, {
    ...currentConfig,
    githubAccounts,
  });
  if (!nextConfig) return currentConfig;

  const createdFiles = [];
  let configCommitted = false;
  try {
    await ensureConfigReviewFiles(nextConfig.githubAccounts, createdFiles);
    const saved = await saveEditedConfig(currentConfig, nextConfig);
    configCommitted = true;
    return saved;
  } finally {
    if (!configCommitted) {
      await Promise.all(createdFiles.map((filePath) => rm(filePath, { force: true })));
    }
  }
}

function reviewerOptionsWithCurrent(agents, currentConfig) {
  const options = reviewerBackendOptions(agents);
  const currentBackend = reviewerBackendForCommand(currentConfig.reviewerCommand);
  if (currentBackend && !options.some((option) => option.value === currentBackend)) {
    options.unshift({
      value: currentBackend,
      label: `${REVIEWER_LABELS[currentBackend] || currentBackend} (current, unavailable)`,
      hint: 'select another backend or restore this CLI before choosing it',
    });
  }
  return options;
}

async function editReviewer(currentConfig) {
  const agents = await detectAgents();
  const currentBackend = reviewerBackendForCommand(currentConfig.reviewerCommand);
  const backendChoice = await p.select({
    message: 'Which shared reviewer backend should all accounts use?',
    options: reviewerOptionsWithCurrent(agents, currentConfig),
    initialValue: currentBackend || 'custom',
  });
  if (p.isCancel(backendChoice)) return currentConfig;

  let reviewerCommand;
  let selectedAgent;
  if (backendChoice === 'custom') {
    const custom = await p.text({
      message: 'Reviewer command (reads stdin and writes JSON to stdout):',
      initialValue: currentBackend ? undefined : currentConfig.reviewerCommand,
      placeholder: 'claude -p --output-format text',
      validate: (value) => value?.trim() ? undefined : 'Required',
    });
    if (p.isCancel(custom)) return currentConfig;
    reviewerCommand = custom.trim();
  } else {
    selectedAgent = agents.find((candidate) => candidate.id === backendChoice);
    if (!selectedAgent || selectedAgent.status === 'not-found') {
      p.log.error(
        `${REVIEWER_LABELS[backendChoice] || backendChoice} is not available on PATH.`,
      );
      return currentConfig;
    }
    if (selectedAgent.status === 'unauthenticated') {
      p.log.warn(
        `${selectedAgent.label} is installed but not authenticated. ` +
          `Run \`${selectedAgent.loginCommand}\` to sign in before continuing.`,
      );
      const proceed = await p.confirm({
        message: 'Continue and verify this backend is ready?',
        initialValue: false,
      });
      if (p.isCancel(proceed) || !proceed) return currentConfig;
      const verifiedAgent = await recheckReviewerAgent({ selectedAgent });
      if (!verifiedAgent) {
        p.log.error(
          `${selectedAgent.label} is still unavailable or not authenticated; no changes were saved.`,
        );
        return currentConfig;
      }
      selectedAgent = verifiedAgent;
    } else if (selectedAgent.status === 'incompatible') {
      p.log.error(
        `${selectedAgent.label} lacks required reviewer isolation flags: ` +
          selectedAgent.missingCapabilities.join(', '),
      );
      return currentConfig;
    }
    reviewerCommand = selectedAgent.reviewerCommand;
  }

  try {
    reviewerCommand = validateReviewerCommandContract(reviewerCommand);
  } catch (err) {
    p.log.error(err.message);
    return currentConfig;
  }

  const backend = backendChoice === 'custom'
    ? null
    : reviewerBackendForCommand(reviewerCommand);
  let model = null;
  if (backend) {
    try {
      model = await selectReviewerModel({
        agent: selectedAgent,
        existingConfig: currentConfig,
        backend,
        onCancel: throwEditCancelled,
      });
    } catch (err) {
      if (err === EDIT_CANCELLED) return currentConfig;
      throw err;
    }
  }

  const nextConfig = await consentedConfigUpdate(currentConfig, {
    ...currentConfig,
    reviewerCommand,
    model,
  });
  if (!nextConfig) return currentConfig;
  return saveEditedConfig(currentConfig, nextConfig);
}

function validateReviewBatchSizeInput(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/u.test(text) || !isValidReviewBatchSize(Number(text))) {
    return 'Enter a whole number within the supported review batch-size range';
  }
  return undefined;
}

async function editReviewBatchSize(currentConfig) {
  const value = await p.text({
    message: 'Maximum concurrent PR reviews:',
    initialValue: String(currentConfig.reviewBatchSize),
    validate: validateReviewBatchSizeInput,
  });
  if (p.isCancel(value)) return currentConfig;
  return saveEditedConfig(currentConfig, {
    ...currentConfig,
    reviewBatchSize: Number(value.trim()),
  });
}

async function editReviewFocusCount(currentConfig) {
  const value = await p.select({
    message: 'How many shared review focus categories should each PR use?',
    initialValue: currentConfig.reviewFocusCount,
    options: [
      { value: 4, label: 'All 4 + synthesis (recommended)', hint: '5 reviewer calls per PR' },
      { value: 3, label: '3 + synthesis', hint: '4 reviewer calls per PR' },
      { value: 2, label: '2 + synthesis', hint: '3 reviewer calls per PR' },
      { value: 1, label: '1 + synthesis', hint: '2 reviewer calls per PR' },
    ],
  });
  if (p.isCancel(value)) return currentConfig;
  if (!isValidReviewFocusCount(value)) throw new Error('invalid review focus count');
  return saveEditedConfig(currentConfig, {
    ...currentConfig,
    reviewFocusCount: value,
  });
}

function validateReviewTimeoutInput(value) {
  const text = String(value ?? '').trim();
  const timeoutMs = Number(text);
  if (!/^\d+$/u.test(text) || !isValidReviewTimeoutMs(timeoutMs)) {
    return `Enter a whole number of milliseconds from ${MIN_REVIEW_TIMEOUT_MS} through ${MAX_REVIEW_TIMEOUT_MS}`;
  }
  return undefined;
}

async function editReviewTimeout(currentConfig) {
  const value = await p.text({
    message: 'Maximum runtime for each reviewer process (milliseconds):',
    initialValue: String(currentConfig.reviewTimeoutMs),
    validate: validateReviewTimeoutInput,
  });
  if (p.isCancel(value)) return currentConfig;
  return saveEditedConfig(currentConfig, {
    ...currentConfig,
    reviewTimeoutMs: Number(value.trim()),
  });
}

async function editStateFile(currentConfig) {
  const value = await p.text({
    message: 'Review state file path:',
    initialValue: currentConfig.stateFile,
    validate: (candidate) => candidate?.trim()
      ? undefined
      : 'Enter a non-empty path',
  });
  if (p.isCancel(value)) return currentConfig;
  const nextConfig = await saveEditedConfig(currentConfig, {
    ...currentConfig,
    stateFile: value.trim(),
  });
  if (nextConfig.stateFile !== currentConfig.stateFile) {
    p.log.warn(
      'This path uses separate review history. The previous state file was left untouched.',
    );
  }
  return nextConfig;
}

async function editReviewBehavior(currentConfig) {
  let config = currentConfig;
  while (true) {
    const choice = await p.select({
      message: 'Review behavior',
      options: reviewBehaviorMenuOptions(config),
    });
    if (p.isCancel(choice) || choice === 'back') return config;
    if (choice === 'batch-size') config = await editReviewBatchSize(config);
    if (choice === 'focus-count') config = await editReviewFocusCount(config);
    if (choice === 'timeout') config = await editReviewTimeout(config);
    if (choice === 'state-file') config = await editStateFile(config);
  }
}

async function editNotifications(currentConfig) {
  const enabled = await p.confirm({
    message: 'Show a desktop notification when a poll finishes with results?',
    initialValue: currentConfig.desktopNotifications,
  });
  if (p.isCancel(enabled)) return currentConfig;
  const nextConfig = await saveEditedConfig(currentConfig, {
    ...currentConfig,
    desktopNotifications: enabled,
  });
  if (enabled && !currentConfig.desktopNotifications &&
      nextConfig.desktopNotifications) {
    await verifyConfiguredNotifications();
  }
  return nextConfig;
}

function schedulePreview(scheduleChoice, intervalMinutes) {
  if (scheduleChoice === 'manual') {
    return manualInstructions({ pollScriptPath, intervalMinutes });
  }
  const previewFns = {
    cron: cronPreview,
    launchd: launchdPreview,
    schtasks: schtasksPreview,
  };
  const preview = previewFns[scheduleChoice]({ pollScriptPath, intervalMinutes });
  return `${preview.preview}\n\nEnvironment file (${preview.environmentPath}):\n${preview.environmentPreview}`;
}

async function editSchedule() {
  const scheduleChoice = await p.select({
    message: 'How should the shared multi-account poller run?',
    options: schedulerChoices(),
  });
  if (p.isCancel(scheduleChoice)) return;

  let intervalMinutes = 15;
  if (scheduleChoice !== 'manual') {
    const interval = await p.text({
      message: scheduleChoice === 'cron'
        ? `How often should it poll? Choose an exact hourly cadence (${SUPPORTED_CRON_INTERVALS.join(', ')} minutes).`
        : 'How often should it poll (minutes)?',
      initialValue: '15',
      validate: (value) => validateScheduleInterval(value, scheduleChoice),
    });
    if (p.isCancel(interval)) return;
    intervalMinutes = Number(interval);
  }

  p.note(schedulePreview(scheduleChoice, intervalMinutes), 'Schedule change');
  const spinner = p.spinner();
  spinner.start(
    scheduleChoice === 'manual'
      ? 'Removing existing OpenMergeLens schedules'
      : `Installing ${scheduleChoice} entry`,
  );
  try {
    await applyScheduleSelection({
      scheduleChoice,
      intervalMinutes,
      selectedPollScriptPath: pollScriptPath,
      installFns: {
        cron: installCron,
        launchd: installLaunchd,
        schtasks: installSchtasks,
      },
    });
    spinner.stop(
      scheduleChoice === 'manual'
        ? 'Existing OpenMergeLens schedules removed'
        : `${scheduleChoice} entry installed`,
    );
    if (scheduleChoice === 'manual') {
      p.note(
        manualInstructions({ pollScriptPath, intervalMinutes }),
        'Manual polling',
      );
    } else {
      p.log.success('Schedule updated');
    }
  } catch (err) {
    spinner.stop(`Schedule transition failed: ${err.message}`);
    p.log.error(
      'The schedule was not changed when rollback was reliable. ' +
        'If the error mentions incomplete rollback, inspect the scheduler manually.',
    );
  }
}

export async function runConfigEditor({
  config: initialConfig,
  choose = (options) => p.select(options),
} = {}) {
  let config = initialConfig;
  while (true) {
    const choice = await choose({
      message: 'OpenMergeLens configuration',
      options: configMenuOptions(config),
    });
    if (p.isCancel(choice) || choice === 'exit') return config;

    if (choice === 'view') {
      p.note(JSON.stringify(config, null, 2), 'Current configuration');
      continue;
    }

    if (choice === 'accounts') config = await editAccounts(config);
    if (choice === 'reviewer') config = await editReviewer(config);
    if (choice === 'review') config = await editReviewBehavior(config);
    if (choice === 'notifications') config = await editNotifications(config);
    if (choice === 'schedule') await editSchedule();
  }
}

export async function main() {
  if (!isInteractiveTerminal()) {
    console.error(
      'openmergelens config requires an interactive terminal (TTY) on stdin and stdout. ' +
        'Run it from a terminal instead of a pipe or scheduler.',
    );
    process.exitCode = 1;
    return;
  }

  p.intro('OpenMergeLens: edit configuration');
  await ensurePrivateDirectory(userHome());
  const releaseOperationLock = await acquireLock(userPath('operation.lock'));
  if (!releaseOperationLock) {
    p.log.error('another operation is active');
    p.outro('Wait for it to finish, then rerun `openmergelens config`.');
    process.exitCode = 1;
    return;
  }

  try {
    let config;
    try {
      config = await loadConfig(configPath);
    } catch (err) {
      throw editorConfigLoadError(err);
    }
    await runConfigEditor({ config });
    p.outro('Configuration editor closed.');
  } finally {
    await releaseOperationLock();
  }
}

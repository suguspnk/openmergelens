import * as p from '@clack/prompts';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAiProcessingConsent,
  retainAiProcessingConsent,
} from './ai-processing-consent.mjs';
import {
  loadConfig,
  saveConfig,
  validateNormalizedConfig,
} from './config.mjs';
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
  configureBitbucketAccounts,
  configureGitHubAccounts,
  isInteractiveTerminal,
  recheckReviewerAgent,
  reviewerBackendOptions,
  providerOptions,
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

export function replaceProviderAccounts(currentConfig, provider, accounts) {
  if (provider === 'github') return { ...currentConfig, githubAccounts: accounts };
  if (provider === 'bitbucket') return { ...currentConfig, bitbucketAccounts: accounts };
  throw new Error(`unknown repository provider ${provider}`);
}

export async function removeProviderAccounts(currentConfig, provider, {
  confirmRemoval = async () => {
    const confirmed = await p.confirm({
      message: `Remove every ${provider === 'github' ? 'GitHub' : 'Bitbucket Cloud'} account?`,
      initialValue: false,
    });
    return !p.isCancel(confirmed) && confirmed;
  },
  updateConsent = consentedConfigUpdate,
  saveUpdate = saveEditedConfig,
} = {}) {
  if (!['github', 'bitbucket'].includes(provider)) {
    throw new Error(`unknown repository provider ${provider}`);
  }
  const otherAccounts = provider === 'github'
    ? currentConfig.bitbucketAccounts || []
    : currentConfig.githubAccounts;
  if (otherAccounts.length === 0) {
    return { config: currentConfig, changed: false, reason: 'last-account' };
  }
  if (!await confirmRemoval()) {
    return { config: currentConfig, changed: false, reason: 'cancelled' };
  }
  const candidate = replaceProviderAccounts(currentConfig, provider, []);
  const consented = await updateConsent(currentConfig, candidate);
  if (!consented) {
    return { config: currentConfig, changed: false, reason: 'consent-declined' };
  }
  return {
    config: await saveUpdate(currentConfig, consented),
    changed: true,
    reason: 'removed',
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

export async function editAccounts(currentConfig, {
  prompts = p,
  configureGitHub = configureGitHubAccounts,
  configureBitbucket = configureBitbucketAccounts,
  updateConsent = consentedConfigUpdate,
  ensureReviewFiles = ensureConfigReviewFiles,
  saveUpdate = saveEditedConfig,
} = {}) {
  const provider = await prompts.select({
    message: 'Which provider accounts and repositories should be edited?',
    options: [...providerOptions(), { value: 'back', label: 'Back' }],
  });
  if (prompts.isCancel(provider) || provider === 'back') return currentConfig;
  if (provider === 'bitbucket' && !reviewerBackendForCommand(currentConfig.reviewerCommand)) {
    prompts.log.error(
      'Bitbucket Cloud requires the generated Codex or Claude reviewer backend. ' +
      'Switch Reviewer backend & model first.',
    );
    return currentConfig;
  }

  const existingProviderAccounts = provider === 'github'
    ? currentConfig.githubAccounts
    : currentConfig.bitbucketAccounts || [];
  if (existingProviderAccounts.length > 0) {
    const action = await prompts.select({
      message: `What should change for ${provider === 'github' ? 'GitHub' : 'Bitbucket Cloud'}?`,
      options: [
        { value: 'edit', label: 'Edit accounts and repositories' },
        { value: 'remove', label: 'Remove this provider' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (prompts.isCancel(action) || action === 'back') return currentConfig;
    if (action === 'remove') {
      const result = await removeProviderAccounts(currentConfig, provider);
      if (result.reason === 'last-account') {
        prompts.log.warn('At least one provider account must remain configured.');
      }
      return result.config;
    }
  }

  let providerAccounts;
  try {
    providerAccounts = provider === 'github'
      ? await configureGitHub({
        existingAccounts: currentConfig.githubAccounts,
        onCancel: throwEditCancelled,
      })
      : await configureBitbucket({
        existingAccounts: currentConfig.bitbucketAccounts || [],
        onCancel: throwEditCancelled,
      });
  } catch (error) {
    if (error === EDIT_CANCELLED) return currentConfig;
    throw error;
  }

  const nextConfig = await updateConsent(
    currentConfig,
    replaceProviderAccounts(currentConfig, provider, providerAccounts),
  );
  if (!nextConfig) return currentConfig;

  const createdFiles = [];
  let configCommitted = false;
  try {
    await ensureReviewFiles(providerAccounts, createdFiles);
    const saved = await saveUpdate(currentConfig, nextConfig);
    configCommitted = true;
    return saved;
  } finally {
    if (!configCommitted) {
      await Promise.all(createdFiles.map((filePath) => rm(filePath, { force: true })));
    }
  }
}

export function reviewerOptionsWithCurrent(agents, currentConfig) {
  const options = reviewerBackendOptions(agents, {
    allowCustom: (currentConfig.bitbucketAccounts?.length || 0) === 0,
  });
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

export async function editReviewer(currentConfig, {
  prompts = p,
  detect = detectAgents,
  updateConsent = consentedConfigUpdate,
  saveUpdate = saveEditedConfig,
} = {}) {
  const agents = await detect();
  const currentBackend = reviewerBackendForCommand(currentConfig.reviewerCommand);
  const backendChoice = await prompts.select({
    message: 'Which shared reviewer backend should all accounts use?',
    options: reviewerOptionsWithCurrent(agents, currentConfig),
    initialValue: currentBackend || 'custom',
  });
  if (prompts.isCancel(backendChoice)) return currentConfig;

  if (backendChoice === 'custom' && (currentConfig.bitbucketAccounts?.length || 0) > 0) {
    prompts.log.error(
      'Bitbucket Cloud requires the generated Codex or Claude reviewer backend. ' +
      'Remove Bitbucket watches before selecting a custom command.',
    );
    return currentConfig;
  }

  let reviewerCommand;
  let selectedAgent;
  if (backendChoice === 'custom') {
    const custom = await prompts.text({
      message: 'Reviewer command (reads stdin and writes JSON to stdout):',
      initialValue: currentBackend ? undefined : currentConfig.reviewerCommand,
      placeholder: 'claude -p --output-format text',
      validate: (value) => value?.trim() ? undefined : 'Required',
    });
    if (prompts.isCancel(custom)) return currentConfig;
    reviewerCommand = custom.trim();
  } else {
    selectedAgent = agents.find((candidate) => candidate.id === backendChoice);
    if (!selectedAgent || selectedAgent.status === 'not-found') {
      prompts.log.error(
        `${REVIEWER_LABELS[backendChoice] || backendChoice} is not available on PATH.`,
      );
      return currentConfig;
    }
    if (selectedAgent.status === 'unauthenticated') {
      prompts.log.warn(
        `${selectedAgent.label} is installed but not authenticated. ` +
          `Run \`${selectedAgent.loginCommand}\` to sign in before continuing.`,
      );
      const proceed = await prompts.confirm({
        message: 'Continue and verify this backend is ready?',
        initialValue: false,
      });
      if (prompts.isCancel(proceed) || !proceed) return currentConfig;
      const verifiedAgent = await recheckReviewerAgent({ selectedAgent });
      if (!verifiedAgent) {
        prompts.log.error(
          `${selectedAgent.label} is still unavailable or not authenticated; no changes were saved.`,
        );
        return currentConfig;
      }
      selectedAgent = verifiedAgent;
    } else if (selectedAgent.status === 'incompatible') {
      prompts.log.error(
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
    prompts.log.error(err.message);
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

  const nextConfig = await updateConsent(currentConfig, {
    ...currentConfig,
    reviewerCommand,
    model,
  });
  if (!nextConfig) return currentConfig;
  return saveUpdate(currentConfig, nextConfig);
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

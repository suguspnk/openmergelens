#!/usr/bin/env node
import * as p from '@clack/prompts';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAiProcessingConsent,
  retainAiProcessingConsent,
} from '../lib/ai-processing-consent.mjs';
import {
  accountLabel,
  CONFIG_VERSION,
  saveConfig,
  validateConfig,
  validateNormalizedConfig,
} from '../lib/config.mjs';
import { detectAgents } from '../lib/agent-detect.mjs';
import { ensurePrivateDirectory } from '../lib/file-security.mjs';
import { ensureLearningsFile, learningsPathFor } from '../lib/learnings.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { isValidReviewBatchSize } from '../lib/poll-batching.mjs';
import { userHome, userPath } from '../lib/paths.mjs';
import {
  ensureReviewPrompt,
  reviewPromptPathFor,
} from '../lib/review-prompts.mjs';
import {
  validateReviewerCommandContract,
  reviewerBackendForCommand,
} from '../lib/reviewer-command-defaults.mjs';
import { isValidReviewFocusCount } from '../lib/reviewer-adapter.mjs';
import {
  cronPreview,
  launchdPreview,
  schtasksPreview,
  schedulerChoices,
  manualInstructions,
  SUPPORTED_CRON_INTERVALS,
} from '../lib/scheduler.mjs';
import {
  applyScheduleSelection,
  canonicalRepositorySelections,
  configureBitbucketAccounts,
  configureGitHubAccounts,
  initialProviderSelections,
  isInteractiveTerminal,
  providerOptions,
  recheckReviewerAgent,
  reviewerBackendOptions,
  selectableReviewerAgents,
  selectReviewerModel,
  validateScheduleInterval,
  verifyConfiguredNotifications,
} from '../lib/setup-interactive.mjs';

export {
  applyScheduleSelection,
  canonicalRepositorySelections,
  isInteractiveTerminal,
  recheckReviewerAgent,
  reviewerBackendOptions,
  selectableReviewerAgents,
  selectReviewerModel,
  validateScheduleInterval,
  verifyConfiguredNotifications,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRootDir = path.resolve(__dirname, '..');
const pollScriptPath = path.join(packageRootDir, 'bin', 'poll.mjs');
const configPath = userPath('config.json');
const reviewPromptTemplatePath = path.join(
  packageRootDir,
  'docs',
  'review-prompt.default.md',
);

export function buildSetupConfig({
  githubAccounts,
  bitbucketAccounts,
  aiProcessingConsent,
  reviewerCommand,
  model,
  reviewFocusCount,
  desktopNotifications,
  existingConfig,
} = {}) {
  return validateNormalizedConfig({
    configVersion: CONFIG_VERSION,
    githubAccounts,
    bitbucketAccounts: bitbucketAccounts ?? existingConfig?.bitbucketAccounts ?? [],
    aiProcessingConsent,
    reviewerCommand,
    model,
    reviewerInputMode: 'stdin',
    reviewBatchSize: isValidReviewBatchSize(existingConfig?.reviewBatchSize)
      ? existingConfig.reviewBatchSize
      : 5,
    reviewFocusCount,
    // The timeout is intentionally manual-only; preserve an existing
    // override without adding another setup prompt.
    reviewTimeoutMs: existingConfig?.reviewTimeoutMs,
    desktopNotifications,
    stateFile: existingConfig?.stateFile || './state.json',
  });
}

export async function finalizeSetup({
  scheduleChoice,
  intervalMinutes,
  account,
  desktopNotifications,
  schedulerOptions = {},
  applySchedule = applyScheduleSelection,
  verifyNotifications = verifyConfiguredNotifications,
  spinner = p.spinner(),
  outro = p.outro,
  setExitCode = (code) => {
    process.exitCode = code;
  },
} = {}) {
  const scheduleAction = scheduleChoice === 'manual'
    ? 'Removing existing OpenMergeLens schedules'
    : `Installing ${scheduleChoice} entry`;
  spinner.start(scheduleAction);
  try {
    await applySchedule({ scheduleChoice, intervalMinutes, schedulerOptions });
    spinner.stop(scheduleChoice === 'manual'
      ? 'Existing OpenMergeLens schedules removed'
      : `${scheduleChoice} entry installed`);
  } catch (err) {
    spinner.stop(
      `Configuration saved, but schedule transition failed: ${err.message}`,
    );
    setExitCode(1);
    outro(
      'Setup incomplete. Configuration was saved, but scheduling failed. ' +
      'Fix the scheduler and rerun `openmergelens init`.',
    );
    return false;
  }

  if (desktopNotifications) {
    await verifyNotifications();
  }

  outro(
    'Setup complete. Try:\n\n' +
    '  openmergelens --dry-run\n\n' +
    `Or one account:\n\n  openmergelens --dry-run --account ${accountLabel(account)}`,
  );
  return true;
}

function exitCancelled() {
  p.cancel('Setup cancelled. Configuration and review files were not changed.');
  throw Object.assign(new Error('setup cancelled'), { code: 'ECANCELLED' });
}

async function readExistingConfig() {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return validateConfig(JSON.parse(raw));
  } catch (err) {
    p.log.warn(`Existing config will not be imported: ${err.message}`);
    return null;
  }
}

async function main() {
  if (!isInteractiveTerminal()) {
    console.error(
      'openmergelens init requires an interactive terminal (TTY) on stdin and stdout. ' +
      'Run it from a terminal instead of a pipe or scheduler.',
    );
    process.exitCode = 1;
    return;
  }

  console.clear();
  p.intro('OpenMergeLens: configure reviewer accounts');
  p.note(
    "OpenMergeLens reviews open pull requests only when a selected account is in the provider's " +
      'Reviewers list. GitHub requests can be added manually or created by a matching ' +
      'CODEOWNERS rule; Bitbucket requests are added in the pull request. After a review, ' +
      'new commits alone do not start another review; the PR author must request the account ' +
      'again in Reviewers.',
    'When reviews run',
  );

  await ensurePrivateDirectory(userHome());
  const releaseOperationLock = await acquireLock(userPath('operation.lock'));
  if (!releaseOperationLock) {
    p.log.error('another operation is active');
    p.outro('Wait for it to finish, then rerun `openmergelens init`.');
    process.exitCode = 1;
    return;
  }

  try {
    const existingConfig = await readExistingConfig();
    const providers = await p.multiselect({
      message: 'Which repository providers should OpenMergeLens configure?',
      options: providerOptions(),
      initialValues: initialProviderSelections(existingConfig),
      required: true,
    });
    if (p.isCancel(providers)) exitCancelled();
    const githubAccounts = providers.includes('github')
      ? await configureGitHubAccounts({
        existingAccounts: existingConfig?.githubAccounts || [],
        onCancel: exitCancelled,
      })
      : [];
    const bitbucketAccounts = providers.includes('bitbucket')
      ? await configureBitbucketAccounts({
        existingAccounts: existingConfig?.bitbucketAccounts || [],
        onCancel: exitCancelled,
      })
      : [];

    const agentSpinner = p.spinner();
    agentSpinner.start('Checking known reviewer CLIs');
    let agents;
    try {
      agents = await detectAgents();
    } catch (err) {
      agentSpinner.stop('Reviewer CLI check failed');
      throw err;
    }
    agentSpinner.stop('Done checking reviewer CLIs');

    const agentOptions = reviewerBackendOptions(agents);

    const backendChoice = await p.select({
      message: 'Which shared reviewer backend should all accounts use?',
      options: agentOptions,
    });
    if (p.isCancel(backendChoice)) exitCancelled();

    let reviewerCommand;
    let selectedAgent;
    if (backendChoice === 'custom') {
      const custom = await p.text({
        message: 'Reviewer command (reads stdin and writes JSON to stdout):',
        initialValue: existingConfig?.reviewerCommand,
        placeholder: 'claude -p --output-format text',
        validate: (value) => value?.trim() ? undefined : 'Required',
      });
      if (p.isCancel(custom)) exitCancelled();
      reviewerCommand = custom.trim();
    } else {
      selectedAgent = agents.find((candidate) => candidate.id === backendChoice);
      if (selectedAgent.status === 'unauthenticated') {
        p.log.warn(
          `${selectedAgent.label} is installed but not authenticated. ` +
          `Run \`${selectedAgent.loginCommand}\` to sign in before continuing.`,
        );
        const proceed = await p.confirm({
          message: 'Continue and verify this backend is ready?',
          initialValue: false,
        });
        if (p.isCancel(proceed) || !proceed) exitCancelled();

        const verifiedAgent = await recheckReviewerAgent({ selectedAgent });
        if (!verifiedAgent) {
          p.log.error(
            `${selectedAgent.label} is still unavailable or not authenticated. ` +
            'Setup cancelled; no configuration was written.',
          );
          exitCancelled();
        }
        selectedAgent = verifiedAgent;
      } else if (selectedAgent.status === 'incompatible') {
        p.log.error(
          `${selectedAgent.label} lacks required reviewer isolation flags: ` +
          selectedAgent.missingCapabilities.join(', '),
        );
        p.log.info('Update the CLI before selecting this backend.');
        exitCancelled();
      }
      reviewerCommand = selectedAgent.reviewerCommand;
    }
    reviewerCommand = validateReviewerCommandContract(reviewerCommand);

    const backend = backendChoice === 'custom'
      ? null
      : reviewerBackendForCommand(reviewerCommand);
    const model = backend
      ? await selectReviewerModel({
        agent: selectedAgent,
        existingConfig,
        backend,
        onCancel: exitCancelled,
      })
      : null;

    // Consent covers the complete selected repository set only after the user
    // evaluates one specific shared reviewer backend. A backend change can
    // change the external processor and its retention/training terms.
    let aiProcessingConsent = retainAiProcessingConsent(
      existingConfig?.aiProcessingConsent,
      existingConfig?.reviewerCommand,
      reviewerCommand,
      [...(existingConfig?.githubAccounts || []), ...(existingConfig?.bitbucketAccounts || [])],
      [...githubAccounts, ...bitbucketAccounts],
    );
    if (!aiProcessingConsent) {
      const allAccounts = [...githubAccounts, ...bitbucketAccounts];
      const repositoryCount = allAccounts.reduce(
        (total, account) => total + account.repositories.length,
        0,
      );
      p.log.warn(
        'The selected reviewer backend may send private source code, pull-request ' +
        'content, and personal data to its provider. Confirm that the repository ' +
        'owner permits this and that provider retention, training, confidentiality, ' +
        'data-residency, and DPA terms are acceptable.',
      );
      const consent = await p.confirm({
        message:
          `Authorize third-party AI processing for all ${repositoryCount} selected ` +
          `repositories across ${allAccounts.length} account(s)?`,
        initialValue: false,
      });
      if (p.isCancel(consent) || !consent) exitCancelled();
      aiProcessingConsent = createAiProcessingConsent(
        reviewerCommand,
        allAccounts,
      );
    }

    const reviewFocusCount = await p.select({
      message: 'How many shared review focus categories should each PR use?',
      initialValue: isValidReviewFocusCount(existingConfig?.reviewFocusCount)
        ? existingConfig.reviewFocusCount
        : 4,
      options: [
        { value: 4, label: 'All 4 + synthesis (recommended)', hint: '5 reviewer calls per PR' },
        { value: 3, label: '3 + synthesis', hint: '4 reviewer calls per PR' },
        { value: 2, label: '2 + synthesis', hint: '3 reviewer calls per PR' },
        { value: 1, label: '1 + synthesis', hint: '2 reviewer calls per PR' },
      ],
    });
    if (p.isCancel(reviewFocusCount)) exitCancelled();

    const desktopNotifications = await p.confirm({
      message: 'Show a desktop notification when a poll finishes with results?',
      initialValue: existingConfig?.desktopNotifications !== false,
    });
    if (p.isCancel(desktopNotifications)) exitCancelled();

    const scheduleChoice = await p.select({
      message: 'How should the shared multi-account poller run?',
      options: schedulerChoices(),
    });
    if (p.isCancel(scheduleChoice)) exitCancelled();

    let intervalMinutes = 15;
    if (scheduleChoice !== 'manual') {
      const interval = await p.text({
        message: scheduleChoice === 'cron'
          ? `How often should it poll? Choose an exact hourly cadence (${SUPPORTED_CRON_INTERVALS.join(', ')} minutes).`
          : 'How often should it poll (minutes)?',
        initialValue: '15',
        validate: (value) => validateScheduleInterval(value, scheduleChoice),
      });
      if (p.isCancel(interval)) exitCancelled();
      intervalMinutes = Number(interval);
    }

    const config = buildSetupConfig({
      githubAccounts,
      bitbucketAccounts,
      aiProcessingConsent,
      reviewerCommand,
      model,
      reviewFocusCount,
      desktopNotifications,
      existingConfig,
    });

    const allConfiguredAccounts = [...githubAccounts, ...bitbucketAccounts];
    const filePreview = allConfiguredAccounts.flatMap((account) =>
      account.repositories.map((repo) => ({
        account: accountLabel(account),
        repo,
        prompt: reviewPromptPathFor(account.hostname, repo),
        learnings: learningsPathFor(account, repo),
      })),
    );
    p.note(JSON.stringify(config, null, 2), `Config to write (${configPath})`);
    p.note(
      filePreview
        .map((entry) =>
          `${entry.account} • ${entry.repo}\n  prompt: ${entry.prompt}\n  learnings: ${entry.learnings}`,
        )
        .join('\n'),
      'Review files',
    );

    let schedulePreview;
    let scheduleEnvironmentNote = '';
    if (scheduleChoice === 'manual') {
      schedulePreview = manualInstructions({ pollScriptPath, intervalMinutes });
    } else {
      const previewFns = { cron: cronPreview, launchd: launchdPreview, schtasks: schtasksPreview };
      const preview = previewFns[scheduleChoice]({ pollScriptPath, intervalMinutes });
      schedulePreview = preview.preview;
      scheduleEnvironmentNote =
        `\n\nEnvironment file (${preview.environmentPath}):\n${preview.environmentPreview}`;
    }
    p.note(`${schedulePreview}${scheduleEnvironmentNote}`, 'Schedule');

    const confirmWrite = await p.confirm({
      message: 'Apply this complete configuration?',
      initialValue: true,
    });
    if (p.isCancel(confirmWrite) || !confirmWrite) exitCancelled();

    const createdFiles = [];
    let configCommitted = false;
    try {
      for (const account of allConfiguredAccounts) {
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
      await saveConfig(configPath, config);
      configCommitted = true;
    } finally {
      if (!configCommitted) {
        await Promise.all(
          createdFiles.map((filePath) => rm(filePath, { force: true })),
        );
      }
    }

    await finalizeSetup({
      scheduleChoice,
      intervalMinutes,
      account: allConfiguredAccounts[0],
      desktopNotifications,
      // The setup E2E harness supplies a temporary scheduler home so its
      // manual cleanup path cannot inspect or change the user's schedules.
      schedulerOptions: process.env.OPENMERGELENS_E2E_SCHEDULER_HOME
        ? { homeDirectory: process.env.OPENMERGELENS_E2E_SCHEDULER_HOME }
        : undefined,
    });
  } finally {
    await releaseOperationLock();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((err) => {
    if (err.code !== 'ECANCELLED') p.log.error(err.message);
    process.exitCode = 1;
  });
}

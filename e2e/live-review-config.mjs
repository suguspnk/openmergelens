import {
  CLAUDE_REVIEWER_COMMAND,
  CODEX_REVIEWER_COMMAND,
  validateReviewerCommandContract,
} from '../lib/reviewer-command-defaults.mjs';
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  REVIEW_INSPECTION_RETRY_COUNT,
} from '../lib/reviewer-adapter.mjs';

export const REVIEWER_BACKENDS = Object.freeze(['claude', 'codex']);
export const DEFAULT_LIVE_REVIEW_MODE = 'post';
export const DEFAULT_LIVE_REVIEW_PROVISION = true;
export const LIVE_REVIEW_CLEANUP_MARGIN_MS = 60_000;

const GENERATED_REVIEWER_COMMANDS = Object.freeze({
  claude: CLAUDE_REVIEWER_COMMAND,
  codex: CODEX_REVIEWER_COMMAND,
});

function parsePositiveInteger(value, name) {
  if (!/^\d+$/u.test(value || '')) {
    throw new Error(`${name} must be a positive whole number`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return parsed;
}

function parseBoundedInteger(value, name, minimum, maximum, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = parsePositiveInteger(value, name);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseBooleanFlag(value, name, fallback) {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === '') return fallback;
  if (normalized === '1') return true;
  if (normalized === '0') return false;
  throw new Error(`${name} must be 1 or 0`);
}

function parseBranch(value) {
  if (value === undefined || value === '') return undefined;
  if (
    value.length > 255 ||
    !/^[A-Za-z0-9._/-]+$/u.test(value) ||
    value.includes('..') ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) {
    throw new Error('OPENMERGELENS_E2E_BASE_BRANCH is not a safe branch name');
  }
  return value;
}

function reviewerConfiguration(environment) {
  const backend = environment.OPENMERGELENS_E2E_REVIEWER_BACKEND
    ?.trim()
    .toLowerCase();
  const customCommand = environment.OPENMERGELENS_E2E_REVIEWER_COMMAND?.trim();

  if (backend && !REVIEWER_BACKENDS.includes(backend)) {
    throw new Error(
      'OPENMERGELENS_E2E_REVIEWER_BACKEND must be claude or codex',
    );
  }
  if (backend && customCommand) {
    throw new Error(
      'Set either OPENMERGELENS_E2E_REVIEWER_BACKEND or ' +
        'OPENMERGELENS_E2E_REVIEWER_COMMAND, not both',
    );
  }
  if (!backend && !customCommand) {
    throw new Error(
      'Set OPENMERGELENS_E2E_REVIEWER_BACKEND=claude or codex, or set ' +
        'OPENMERGELENS_E2E_REVIEWER_COMMAND for a custom MCP-compatible reviewer',
    );
  }

  if (backend) {
    return {
      reviewerBackend: backend,
      reviewerCommand: GENERATED_REVIEWER_COMMANDS[backend],
    };
  }

  return {
    reviewerBackend: 'custom',
    reviewerCommand: validateReviewerCommandContract(customCommand),
  };
}

export function calculateLiveReviewWatchdogMs({ reviewFocusCount, reviewTimeoutMs }) {
  const reviewCallCount = reviewFocusCount + 1;
  const reviewAttemptCount = REVIEW_INSPECTION_RETRY_COUNT + 1;
  return reviewCallCount * reviewAttemptCount * reviewTimeoutMs +
    LIVE_REVIEW_CLEANUP_MARGIN_MS;
}

export function parseEnvironment(environment = process.env) {
  const missing = [
    'OPENMERGELENS_E2E_REPO',
    'OPENMERGELENS_E2E_USERNAME',
  ].filter((key) => !environment[key]?.trim());
  if (missing.length > 0) {
    return {
      error: [
        'Live review E2E is intentionally opt-in.',
        `Set: ${missing.join(', ')}.`,
        'See e2e/README.md for the author/reviewer credentials and test repository setup.',
      ].join(' '),
    };
  }

  try {
    const mode = (environment.OPENMERGELENS_E2E_MODE || DEFAULT_LIVE_REVIEW_MODE)
      .trim();
    if (mode !== 'dry-run' && mode !== 'post') {
      throw new Error('OPENMERGELENS_E2E_MODE must be dry-run or post');
    }

    const provision = parseBooleanFlag(
      environment.OPENMERGELENS_E2E_PROVISION,
      'OPENMERGELENS_E2E_PROVISION',
      DEFAULT_LIVE_REVIEW_PROVISION,
    );
    const host = (environment.OPENMERGELENS_E2E_HOST || 'github.com').trim() ||
      'github.com';
    const repository = environment.OPENMERGELENS_E2E_REPO.trim();
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
      throw new Error('OPENMERGELENS_E2E_REPO must be OWNER/REPO');
    }

    const numberText = environment.OPENMERGELENS_E2E_PR?.trim();
    const number = numberText
      ? parsePositiveInteger(numberText, 'OPENMERGELENS_E2E_PR')
      : undefined;
    const username = environment.OPENMERGELENS_E2E_USERNAME.trim();
    const authorUsername = environment.OPENMERGELENS_E2E_AUTHOR_USERNAME?.trim();
    if (provision && !authorUsername) {
      throw new Error(
        'OPENMERGELENS_E2E_AUTHOR_USERNAME is required when ' +
          'OPENMERGELENS_E2E_PROVISION is enabled',
      );
    }
    if (
      provision &&
      authorUsername.toLowerCase() === username.toLowerCase()
    ) {
      throw new Error(
        'OPENMERGELENS_E2E_AUTHOR_USERNAME must differ from ' +
          'OPENMERGELENS_E2E_USERNAME so GitHub can request the reviewer',
      );
    }
    if (!provision && number === undefined) {
      throw new Error(
        'OPENMERGELENS_E2E_PR is required when OPENMERGELENS_E2E_PROVISION=0',
      );
    }

    return {
      mode,
      provision,
      host,
      repository,
      number,
      username,
      authorUsername,
      baseBranch: parseBranch(environment.OPENMERGELENS_E2E_BASE_BRANCH?.trim()),
      ...reviewerConfiguration(environment),
      reviewFocusCount: parseBoundedInteger(
        environment.OPENMERGELENS_E2E_REVIEW_FOCUS_COUNT,
        'OPENMERGELENS_E2E_REVIEW_FOCUS_COUNT',
        1,
        4,
        1,
      ),
      reviewTimeoutMs: parseBoundedInteger(
        environment.OPENMERGELENS_E2E_REVIEW_TIMEOUT_MS,
        'OPENMERGELENS_E2E_REVIEW_TIMEOUT_MS',
        60_000,
        3_600_000,
        DEFAULT_REVIEW_TIMEOUT_MS,
      ),
      keepHome: parseBooleanFlag(
        environment.OPENMERGELENS_E2E_KEEP_HOME,
        'OPENMERGELENS_E2E_KEEP_HOME',
        false,
      ),
      keepPr: parseBooleanFlag(
        environment.OPENMERGELENS_E2E_KEEP_PR,
        'OPENMERGELENS_E2E_KEEP_PR',
        false,
      ),
    };
  } catch (error) {
    return { error: error.message };
  }
}

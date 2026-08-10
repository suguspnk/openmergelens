import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_REVIEWER_COMMAND,
  CODEX_REVIEWER_COMMAND,
} from '../lib/reviewer-command-defaults.mjs';
import { DEFAULT_REVIEW_TIMEOUT_MS } from '../lib/reviewer-adapter.mjs';
import {
  calculateLiveReviewWatchdogMs,
  DEFAULT_LIVE_REVIEW_MODE,
  DEFAULT_LIVE_REVIEW_PROVISION,
  LIVE_REVIEW_CLEANUP_MARGIN_MS,
  parseEnvironment,
} from '../e2e/live-review-config.mjs';
import {
  LIVE_REVIEW_FIXTURE_SOURCE,
  inlineCommentExists,
} from '../e2e/live-review-github.mjs';

function baseEnvironment(overrides = {}) {
  return {
    OPENMERGELENS_E2E_REPO: 'owner/repo',
    OPENMERGELENS_E2E_PR: '123',
    OPENMERGELENS_E2E_USERNAME: 'e2e-reviewer',
    OPENMERGELENS_E2E_AUTHOR_USERNAME: 'e2e-author',
    ...overrides,
  };
}

test('live review E2E defaults to provisioning and posting', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_PR: undefined,
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'codex',
  }));

  assert.equal(config.error, undefined);
  assert.equal(config.mode, DEFAULT_LIVE_REVIEW_MODE);
  assert.equal(config.mode, 'post');
  assert.equal(config.provision, DEFAULT_LIVE_REVIEW_PROVISION);
  assert.equal(config.number, undefined);
  assert.equal(config.reviewTimeoutMs, DEFAULT_REVIEW_TIMEOUT_MS);
});

test('live E2E config selects the generated Claude reviewer command', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'claude',
  }));

  assert.equal(config.error, undefined);
  assert.equal(config.reviewerBackend, 'claude');
  assert.equal(config.reviewerCommand, CLAUDE_REVIEWER_COMMAND);
});

test('live E2E config selects the generated Codex reviewer command', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'CODEX',
  }));

  assert.equal(config.error, undefined);
  assert.equal(config.reviewerBackend, 'codex');
  assert.equal(config.reviewerCommand, CODEX_REVIEWER_COMMAND);
});

test('live E2E config accepts a validated custom MCP reviewer command', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_COMMAND:
      'custom-reviewer --config {{mcp_config}} --tool {{mcp_tool}}',
  }));

  assert.equal(config.error, undefined);
  assert.equal(config.reviewerBackend, 'custom');
  assert.match(config.reviewerCommand, /custom-reviewer/u);
});

test('live E2E config rejects an ambiguous backend and command selection', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'claude',
    OPENMERGELENS_E2E_REVIEWER_COMMAND:
      'custom-reviewer --config {{mcp_config}} --tool {{mcp_tool}}',
  }));

  assert.match(config.error, /either .* or .* not both/u);
});

test('live E2E config rejects missing reviewer selection', () => {
  const config = parseEnvironment(baseEnvironment());

  assert.match(config.error, /REVIEWER_BACKEND=claude or codex/u);
});

test('live E2E config rejects unsupported reviewer backends', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'gemini',
  }));

  assert.match(config.error, /must be claude or codex/u);
});

test('live E2E config allows the default posting mode without a second confirmation', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'codex',
    OPENMERGELENS_E2E_MODE: 'post',
  }));

  assert.equal(config.error, undefined);
  assert.equal(config.mode, 'post');
});

test('existing-PR dry runs remain available without an author account', () => {
  const config = parseEnvironment(baseEnvironment({
    OPENMERGELENS_E2E_AUTHOR_USERNAME: undefined,
    OPENMERGELENS_E2E_PROVISION: '0',
    OPENMERGELENS_E2E_MODE: 'dry-run',
    OPENMERGELENS_E2E_REVIEWER_BACKEND: 'codex',
  }));

  assert.equal(config.error, undefined);
  assert.equal(config.provision, false);
  assert.equal(config.number, 123);
  assert.equal(config.mode, 'dry-run');
});

test('live E2E config rejects missing or same author and reviewer accounts', () => {
  assert.match(
    parseEnvironment(baseEnvironment({
      OPENMERGELENS_E2E_AUTHOR_USERNAME: undefined,
    })).error,
    /AUTHOR_USERNAME is required/u,
  );
  assert.match(
    parseEnvironment(baseEnvironment({
      OPENMERGELENS_E2E_AUTHOR_USERNAME: 'E2E-REVIEWER',
    })).error,
    /must differ/u,
  );
});

test('live E2E fixture and review correlation require an anchored comment', () => {
  assert.match(LIVE_REVIEW_FIXTURE_SOURCE, /exec\(`git status/u);
  assert.equal(
    inlineCommentExists(
      { id: 7 },
      [{ pull_request_review_id: '7', path: 'fixture.mjs', line: 4 }],
    ),
    true,
  );
  assert.equal(
    inlineCommentExists(
      { id: 7 },
      [{ pull_request_review_id: 7, path: '', line: 4 }],
    ),
    false,
  );
  assert.equal(
    inlineCommentExists(
      { id: 7 },
      [{ pull_request_review_id: 8, path: 'fixture.mjs', line: 4 }],
    ),
    false,
  );
});

test('live E2E watchdog covers every focused pass, synthesis, and retry', () => {
  assert.equal(
    calculateLiveReviewWatchdogMs({
      reviewFocusCount: 4,
      reviewTimeoutMs: 3_600_000,
    }),
    (4 + 1) * (1 + 1) * 3_600_000 + LIVE_REVIEW_CLEANUP_MARGIN_MS,
  );
});

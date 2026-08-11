# Changelog

OpenMergeLens follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Fixed review scheduling so only pull requests with a current, validated
  GitHub review request enter the queue; trustworthy searches also retire stale
  state without risking cross-account or cross-repository cleanup. Pagination
  metadata and candidate counts must prove complete before either action.

## [1.5.1] - 2026-08-10

- Increased the default reviewer process timeout to 30 minutes and aligned
  the live-review configuration with that default.
- Reported review-queue metadata budget deferrals as deferred outcomes and
  retained them in poll reports for accurate queue status.

## [1.5.0] - 2026-08-07

- Added `openmergelens config`, an interactive editor for accounts,
  repositories, reviewer behavior, notifications, and scheduling that validates
  and saves each completed change without rerunning the full setup wizard.
- Added configurable reviewer process timeouts through `reviewTimeoutMs`, with
  safe bounds and preservation of existing values during setup.
- Added structured JSONL polling logs with sanitized, bounded diagnostics,
  private rotation, and readable progress output for manual runs.
- Expanded cross-platform setup, scheduling, and live-review end-to-end
  coverage, including self-provisioning GitHub review fixtures.

## [1.4.0] - 2026-08-06

- Deferred reviews when a pull request changes head during review: stale
  results are discarded, state remains untouched, and the next poll retries
  the new head without an attention notification.
- Hardened multi-account and multi-host discovery with explicit repository
  scopes, paginated fallback when GitHub search caps results, account-scoped
  state, and rotating overflow scheduling.
- Added bounded, fair review queueing and admission limits so one account,
  repository, or stable candidate prefix cannot starve other work.
- Hardened reviewer execution and GitHub posting with constrained per-review
  read-only MCP access, structured-output and anchor validation, summary
  fallback for unanchored findings, mutation serialization, rate-limit
  handling, and review-marker reconciliation.
- Hardened setup and scheduling across cron, launchd, and Windows Task
  Scheduler, including config migration and consent validation, reviewer
  detection, environment restoration, interval validation, and rollback
  safety.
- Added failure handling and regression coverage for malformed metadata,
  missing heads, scheduler startup failures, and diff and search edge cases.

## [1.3.0] - 2026-08-05

- Added built-in Codex and Claude model/reasoning selection during `init`, with
  current model catalogs, safe custom model IDs, CLI-default fallbacks, and
  runtime forwarding without re-opening consent or resetting review state.

## [1.2.0] - 2026-07-31

- Replaced reviewer-supplied GitHub command arrays with fixed semantic
  metadata plus paginated cumulative-diff and raw file-context operations.
  Incomplete inspection passes now report sanitized coverage diagnostics and
  retry once before the review fails closed.
- Added private per-poll HTML review reports that open from supported
  notification body/actions, with a cross-platform `openmergelens report`
  command, interactive `--list` picker, bounded retention, and Linux fallback
  behavior for notification servers without action support. Reports group
  pull requests by reviewer account and repository for easier scanning.

## [1.1.3] - 2026-07-30

- Fixed lock acquisition fallback handling so unrelated silent candidates do
  not release or overwrite the active lock owner.
- Fixed reviewer CLI auth detection when the configured command resolves
  through Windows path fallbacks and scheduled environment allowlists.

## [1.1.2] - 2026-07-30

- Fixed scheduled OpenMergeLens runs on Linux so they restore the setup-time
  session environment needed for desktop notifications.
- Fixed Windows reviewer command launches so extensionless shims such as
  Codex's npm executable resolve through `PATHEXT` instead of failing with
  `ENOENT`.

## [1.1.1] - 2026-07-29

- Replaced repository-by-repository AI-processing confirmations with one
  explicit consent covering the complete selected repository set. Existing
  version 2 configs migrate conservatively, and reviewer or repository-set
  changes require one fresh bulk confirmation.
- Skip pull requests that are already closed or merged, and re-check their
  state before posting so a pull request closed during review is not updated.
- Added a concise README quick start and a maintainer launch field guide for
  clean-install checks, early-user interviews, privacy-preserving measurements,
  and feedback routing.
- Replaced deprecated macOS notification delivery on macOS 13 and later with a
  maintained universal helper in a dedicated OpenMergeLens application bundle,
  using the website's official mark while preserving the legacy helper for
  older Macs. The notifier bundle version now invalidates pre-logo macOS icon
  registrations.
- Added a setup-time desktop notification test with confirmation and
  platform-specific recovery guidance when delivery fails or the operating
  system suppresses the alert. The confirmation is displayed while the test
  alert is active, every setup-only probe uses a fresh notification identity,
  and macOS guidance explains that the locally signed helper cannot override
  Focus.
- macOS 13+ notifications now remain until the user dismisses them. A newer
  OpenMergeLens notification replaces the previous one without blocking polls.

## [1.0.1] - 2026-07-29

- Fixed non-interactive Codex reviews cancelling the constrained GitHub
  inspection tool, and rejected reviewer output unless required PR metadata and
  cumulative diff reads complete successfully.
- Pointed published package metadata at the canonical OpenMergeLens product
  site.

## [1.0.0] - 2026-07-28

Initial stable release of local, scheduled GitHub pull-request reviews using
Codex, Claude Code, or a compatible MCP-enabled reviewer CLI.

- Added cross-platform CI and installed-package smoke testing.
- Added staged npm publishing with trusted-publisher provenance.
- Added community health, security, support, and release documentation.
- Added standard `--help` and `--version` CLI flags.
- Raised the supported runtime to maintained Node.js releases.
- Made reviewer-command safety validation fail at configuration load time.
- Corrected the bundled manual configuration example.
- Added visible AI attribution to every posted pull-request review.
- Added repository-scoped consent before third-party AI processing, with
  re-consent when the reviewer backend changes.
- Serialized GitHub review mutations and added rate-limit-aware backoff.

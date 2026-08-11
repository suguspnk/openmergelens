# Code Quality Guidelines

Project-specific coding standards for OpenMergeLens. This is the reference that
[`docs/review-prompt.default.md`](review-prompt.default.md) (the prompt seeded
for every watched repository) is distilled from: read this for the *why*,
use the review prompt as the quick-scan version. Read alongside
[`docs/tech-stack-standards.md`](tech-stack-standards.md) (external
library/tool best practices) and [`PRD.md`](../PRD.md) (design rationale).

Applies to all code in this repo: `bin/`, `lib/`, and `test/`.

## Table of Contents

- [Error Handling](#error-handling)
- [Module Organization](#module-organization)
- [Security: Shelling Out](#security-shelling-out)
- [Security: Credentials & Secrets](#security-credentials--secrets)
- [Dependency Hygiene](#dependency-hygiene)
- [Testing](#testing)
- [Performance](#performance)

## Error Handling

- **Distinguish operational errors from programmer errors.** Bad input, a
  failed `gh` call, a reviewer CLI timeout, or a missing `config.json` field
  are operational: handle them, log them, keep going. A type bug or
  undefined-property access is a programmer error: let it crash loudly
  (`main().catch(...)` at the entrypoint) rather than limping on in a
  corrupted state.
- **Never swallow an error by returning `null`/`undefined` to signal
  failure.** Reserve those for genuinely expected "no result" cases (e.g.
  `searchReviewRequestedPRs` returning an empty array: no PRs found is not
  an error). If something failed, throw or reject; don't hide the cause
  behind a falsy return.
- **Never let one PR's failure abort the whole poll batch.** The loop in
  `bin/poll.mjs` catches per-PR and per-target, logs via `logFailure`, and
  `continue`s. This is deliberate and must be preserved when the loop is
  extended. Only a true top-level/programmer error should escalate past
  `main()`.
- **Attach context as errors bubble.** `gh()`'s errors already include the
  failing command; the shared logger records which account, PR, and step
  (search / pr-view / diff / invoke-reviewer / post-review) failed. Keep doing
  this: a structured `poll.log` record should be actionable without attaching
  a debugger.
- **Never blindly retry a review POST.** A timed-out request may have reached
  GitHub. Every posted review must retain its deterministic hidden marker, and
  ambiguous failures or missing local state must be reconciled against the
  submitted-review list before another POST is attempted. The summary-only
  fallback is limited to confirmed HTTP 422 validation failures.
- **Authorization is a mutation-boundary invariant.** Candidate discovery is
  not durable permission to post. After generation and immediately before
  every review POST (including a 422 fallback), require an open PR, the expected
  head, and the exact configured login in the active requested-reviewer list.
  Revocation is an expected no-post result; malformed or failed authorization
  lookup fails closed. Read-only reconciliation remains allowed after a POST
  clears the request.
- **On reviewer-CLI failure or empty/malformed output: skip posting, leave
  state untouched.** This is a load-bearing invariant (see PRD.md). Never
  post a broken or empty review or advance `state.json`'s
  last-reviewed SHA for a PR that wasn't actually reviewed, so the next poll
  retries automatically.
- **Never let a raw stack trace or internal error object reach anything
  posted externally** (a GitHub review body/comment). Stack traces and full
  error objects belong in `poll.log` only; anything posted to GitHub gets a
  clean, human-readable message.
- **Always `await` inside `try/catch` in async code.** A missing `await` on
  a promise means its rejection escapes the `catch` block entirely and
  surfaces as an unhandled rejection instead.

## Module Organization

- **`bin/*.mjs` are thin entrypoints only**: argument parsing, wiring
  `lib/` calls together, top-level error handling. No business logic lives
  in `bin/`; if a `bin/` file starts accumulating non-trivial logic, that
  logic belongs in a `lib/` module.
- **Each `lib/*.mjs` module owns exactly one external boundary.**
  `github.mjs` is the only module that calls `gh`; `github-auth.mjs` is the
  only module that resolves credentials; `reviewer-adapter.mjs` is the only
  module that spawns the configurable reviewer command; `state.mjs` is the
  only module that reads/writes `state.json`; `lock.mjs` is the only module
  that touches the lock file. Don't reach around a boundary module to do
  its job from elsewhere. This keeps each boundary independently
  testable and swappable (see PRD.md's "agent-agnostic reviewer" and
  "swappable auth" constraints).
- **Separate side effects from pure logic.** Diff-line-anchoring
  (`diffAnchors`), severity formatting, config validation, and SHA
  comparison (`needsReview`) don't touch the filesystem or network: keep
  them as pure functions so they're testable with zero mocking. Subprocess
  calls, file I/O, and network/API calls stay isolated in their owning
  boundary module.
- **Validate external config in one place, at load time.** `config.json` is
  user-edited and can be malformed; validate required fields where it's
  first read (see `validateConfig`'s explicit checks) and fail
  fast with a clear message, rather than surfacing a confusing error deep
  inside unrelated logic three calls later.
- **No hidden module-level mutable state.** Pass config, auth, and state
  explicitly as function arguments and return values (as
  `pollOnce({ config, stateFile, logPath, accountSelector })`
  already does) rather than reaching for shared globals. This keeps data
  flow traceable and makes every function's dependencies explicit at the
  call site.

## Security: Shelling Out

This is the single highest-stakes area in this codebase: OpenMergeLens
processes untrusted PR content (titles, bodies, diffs) and shells out to
both `gh` and a user-configured reviewer command. See
[`docs/tech-stack-standards.md`](tech-stack-standards.md#shellcommand-injection-avoidance)
for the general pattern; these are the OpenMergeLens-specific rules.

- **Always pass arguments as an array via `execFile`/`spawn`, never as a
  concatenated string, and never with `shell: true`.** No exceptions for
  "trusted" input: PR titles/bodies/diffs are attacker-influenceable by
  definition (anyone who can open a PR controls this content), and even the
  user-configured `reviewerCommand` string must still be tokenized into
  `{cmd, args}` and spawned with `shell: false` (see
  `reviewer-adapter.mjs`'s `parseCommand`), never string-interpolated.
- **Set a timeout on every subprocess call, no exceptions.** A hung or
  malicious subprocess must not block the poller indefinitely. Every `gh`
  invocation, every `github-auth.mjs` call, and every reviewer-CLI
  invocation must specify an explicit `timeout`, as defined by `GH_TIMEOUT_MS` /
  `GH_AUTH_TIMEOUT_MS` and `reviewer-adapter.mjs`'s configured `timeoutMs`
  default.
- **Untrusted content goes through stdin or a file, never through argv when
  avoidable.** `postReview` sends its JSON payload via `--input -` +
  `child.stdin`; `invokeReviewer` writes the prompt to `child.stdin`. This
  avoids argv length limits, keeps content out of `ps`/process-listing
  output, and sidesteps argument/flag-injection risk from content that
  happens to start with `-`.
- **A configured command being "trusted" doesn't make its runtime arguments
  trusted.** `reviewerCommand` is a value the user chose, but the PR content it
  retrieves with `gh` is still untrusted: don't assume a trusted base command
  means everything downstream of it is safe. The fixed prompt must forbid
  commands sourced from PR content and all GitHub mutations.
- **Never blanket-inherit environment into a subprocess that doesn't need
  it.** Pass through only what's required; `github-auth.mjs`'s
  `authEnvironment` explicitly deletes ambient `GH_TOKEN`/`GITHUB_TOKEN`/etc.
  before setting the one scoped credential that should actually apply, so
  a stray environment variable can never silently override the account
  selected in `init`.
- **Reviewer GitHub access stays account-scoped and operationally read-only.**
  Never expose the selected account credential to the reviewer process. Route
  its structured inspection tool through the per-review gateway, which validates
  the fixed PR, repository, HTTP method, and endpoint before using the
  credential in the parent process. The generated Codex command uses a
  deny-root filesystem profile and has no direct network access. Claude must
  expose only the same MCP tool, never Bash or general filesystem tools.
- **Sanitize before logging.** Subprocess stdout/stderr written to
  `poll.log` should never include raw, unfiltered output from a tool that
  might echo a token or credential. The logger must also cap messages and
  diagnostics, rotate the active log, preserve only an allowlisted set of
  operational fields, and retain useful exit/status metadata. This matters
  especially for `reviewerCommand`, which is an arbitrary external binary
  OpenMergeLens doesn't control.

## Security: Credentials & Secrets

- **Never persist a token in `config.json` or `state.json`.** Both are
  plain JSON on disk with no encryption. Rely on `gh`'s own keychain-backed
  credential storage (macOS Keychain / Windows Credential Manager / libsecret)
  via `github-auth.mjs`'s `resolveGitHubAuth`, which fetches a token
  on-demand per run rather than OpenMergeLens storing one itself.
  `config.json`/`state.json` stay gitignored for the same reason. Never
  remove them from `.gitignore`.
- **Never log a secret.** No token, even truncated, should reach
  `poll.log`, `console.log`, or an error message. If a future change needs
  to log auth-related diagnostics, log the account identity
  (`OPENMERGELENS_GITHUB_ACCOUNT`-style `user@host`) rather than the token itself.
- **Scope credentials to the minimum needed.** When multiple GitHub
  accounts are configured, resolve and use only the account attached to that
  queued operation: don't fall back to a broader or
  ambient credential "just in case."
- **Treat env-var-based auth as a documented fallback, not the default
  path.** An env var is visible to any process that can read
  `/proc/<pid>/environ` or to child processes that inherit it: strictly
  less safe than `gh`'s keychain-backed resolution. If a code path needs to
  fall back to `GH_TOKEN`/`GITHUB_TOKEN`, that should be an explicit,
  documented exception, not silent default behavior.
- **Don't encourage broad, long-lived tokens.** OpenMergeLens should never ask a
  user to paste a personal access token into a config file: auth setup
  goes through `gh auth login`, keeping token lifecycle and scope under
  GitHub CLI's own management.

## Dependency Hygiene

- **Commit `pnpm-lock.yaml` and install with `pnpm install --frozen-lockfile`
  in any automated context.** Deterministic, auditable dependency
  resolution. Never let a stale lockfile silently drift.
- **Default to Node built-ins over adding a package.** `node:child_process`,
  `node:fs`, `node:test`, `node:util` cover everything this project needs
  today. Every new dependency (there is currently exactly one:
  `@clack/prompts`) expands the trusted code-execution surface of a tool
  that already shells out and handles GitHub credentials. That is a real
  cost, not a formality.
- **Vet any new dependency before adding it.** Check maintenance activity,
  download counts, and vulnerability/advisory history before running
  `pnpm add`. Prefer well-known, actively maintained packages over obscure
  ones, especially ones with recent unexplained ownership/maintainer
  transfers.
- **Audit postinstall scripts before trusting a new dependency's install
  step.** Lifecycle scripts from dependencies are a common supply-chain
  attack vector; this project has no native build step that requires them.
- **Review every `pnpm-lock.yaml` diff, not just `package.json`.** With a
  dependency tree this small, a manual look at what actually changed
  (including transitive bumps) is feasible and worth doing on every PR that
  touches dependencies.

## Testing

- **Unit-test pure logic exhaustively, with zero mocking required.**
  `diffAnchors`, severity formatting, `parseAuthStatus`,
  `validateConfig`, `needsReview`'s SHA comparison, and
  `lock.mjs`'s reclaim logic are the cheapest, highest-value test surface
  in this codebase. See `test/github-auth.test.mjs`,
  `test/state.test.mjs`, and `test/lock.test.mjs` for the level of coverage
  expected (basic semantics, malformed config shapes, and
  concurrency/race scenarios where relevant). Prefer this over mocking
  wherever the logic in question doesn't actually need a subprocess or
  filesystem call to be exercised.
- **When a boundary genuinely needs mocking to test (subprocess calls,
  network), wrap it behind one thin function per module and mock that
  function; never mock `child_process` globals directly.** `node:test`'s
  `t.mock`/`mock.method()` auto-restores the original after each test,
  avoiding cross-test leakage. No test in this repo currently needs this
  (everything covered so far is pure-logic or filesystem-against-a-temp-dir),
  but it's the pattern to reach for once one does, such as when testing
  `github.mjs`'s handling of a malformed `gh` response without actually
  calling `gh`.
- **Integration-test each boundary's failure modes, not just its happy
  path.** Empty output, non-zero exit, malformed JSON, and timeout from
  `gh` or the reviewer CLI are exactly the cases the "skip posting, leave
  state untouched" invariant depends on. That behavior needs a regression
  test, not just a manual check.
- **Never touch the real `state.json`/`config.json` in a test.** Use a temp
  file/directory per test (see the temp-path pattern in `test/lock.test.mjs`),
  and clean up after every test, including on failure.
- **Reserve real subprocess invocation (an actual `gh` or reviewer binary)
  for manual/opt-in smoke tests**, not the default `npm test` run: real
  calls are slow, flaky, and require live auth/network that CI or a fresh
  clone won't have.
- **New or changed logic needs a corresponding test**, especially error
  paths and the "don't post/don't advance state if invalid" invariants;
  not just coverage of the success path. This is checked in review (see
  [`docs/review-prompt.default.md`](review-prompt.default.md)'s Tests section).

## Performance

- **This is a low-frequency poller, not a hot path**: polling runs every
  N minutes via cron/launchd/Task Scheduler, so premature optimization here
  has essentially no payoff. Prioritize correctness and clarity over
  micro-optimizing any single poll cycle.
- **Where performance does matter, it's about not doing unnecessary network
  round-trips**, not CPU: use `--jq`/`--json` filtering server-side (via
  `gh api`) rather than fetching more than needed and filtering in Node;
  use `--paginate` correctly rather than looping manual page-fetch calls.
  Re-fetch metadata only for explicit safety boundaries: post-generation
  confirmation, immediately-before-POST authorization, and the bounded
  historical-state sweep. Never reuse an earlier read to authorize a later
  mutation.
- **Avoid unbounded work driven by external input.** A single PR's diff
  size, or the number of PRs a poll cycle finds, is attacker/environment
  influenced in the loose sense of a very large or very active repo. Keep
  per-call `maxBuffer`/timeout settings in place rather than assuming
  inputs stay small.
- **Bound local state as well as network work.** Keep `state.json` within 16
  MiB and 10,000 review records, validate bounded canonical fields before use,
  expire records after 365 days, and check at most 25 eligible historical keys
  per poll. Only direct `CLOSED`/`MERGED` metadata may delete a scoped key;
  absence, failure, malformed data, and 404 retain it. Reserve a new-key slot
  before posting and roll back every in-memory batch if its atomic save fails.

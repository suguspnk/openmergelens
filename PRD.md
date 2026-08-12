# PR Review Bot: Handoff Spec

Local, agent-agnostic poller that auto-reviews open GitHub PRs whenever a
configured account is the requested reviewer. The request can be added manually
or created automatically by a matching `CODEOWNERS` rule. It re-reviews a new
head only when GitHub returns that PR from a fresh active review-request search.
Posts results as a formal GitHub PR review with inline comments automatically,
with no per-run approval needed.

Repo: `~/Symph/projects/pr-review-bot` (git initialized with no remote; keep it
local only unless explicitly decided otherwise later).

This doc is the full spec for the current implementation. Keep it aligned with
the shipped CLI and its tests when behavior changes.

## Why this exists (context from design conversation)

- Claude Code / `claude-code-action` has no built-in "watch GitHub, trigger
  local review on reviewer-assignment" feature. GitHub Actions triggers always
  run on Actions runners (GitHub-hosted or self-hosted); this project
  deliberately avoids committing any `.github/workflows/*.yml`: no workflow
  file, no webhook, no tunnel. Pure client-side polling using `gh` CLI.
- Requirements gathered from user:
  1. Trigger scope: an open PR must have the configured account in GitHub's
     requested-reviewer list. That request may be added manually, or GitHub may
     create it when a matching `CODEOWNERS` rule applies. The
     `review_requested` search qualifier covers the resulting request, but we're
     polling rather than subscribing to webhooks, so we detect it via periodic
     search, not the event itself. OpenMergeLens does not parse `CODEOWNERS` or
     create requests.
  2. "Seen ≠ done": must not just track "have I looked at this PR" but track
     **new commits since the last review** so a freshly requested re-review can
     target the new head. State is keyed by reviewer account + PR + last-reviewed
     commit SHA, not a boolean seen/unseen flag. new commits alone are not a trigger
     for any PR; the PR author must request that account again in GitHub's
     **Reviewers** list before the new head enters discovery.
  3. Needs a real review prompt, not "review this PR." Prompts are directly
     editable and shared per GitHub host/repository. Durable corrections are
     isolated per GitHub host/account/repository.
  4. Output: post directly as a formal GitHub PR review through the REST
     reviews endpoint, with inline comments, as pre-approved by the user for
     this specific automated flow, with no confirmation prompt needed each run.
     (This approval is scoped to this bot's own posting behavior and is not a
     general standing permission for PR comments in other contexts.)
  5. Agent-agnostic: don't hardcode a `claude` CLI invocation. The "reviewer
     backend" should be a swappable prompt-only stdin command/adapter that uses
     the constrained MCP inspection tool and returns structured review JSON.
     The diff is inspected through MCP and is never embedded in reviewer input.
  6. Run mode: no preference given. Default to **one-shot script + externally
     scheduled** (cron/launchd/`/loop`), since that's simplest to test and
     most flexible. A built-in loop mode can be added later if wanted.

## Architecture

```
openmergelens/
├── PRD.md                  (this file)
├── package.json            (pnpm, type: module, bin entry)
├── pnpm-lock.yaml
├── config.example.json     (versioned multi-account config template)
├── docs/
│   └── review-prompt.default.md (bundled seed for editable repository prompts)
├── bin/
│   ├── poll.mjs             (one-shot poll entrypoint)
│   ├── init.mjs              (interactive onboarding wizard: @clack/prompts)
│   └── config.mjs            (interactive existing-config editor)
├── lib/
│   ├── config-editor.mjs     (grouped immediate-save configuration editor)
│   ├── setup-interactive.mjs (shared setup/config prompts and validation)
│   ├── github.mjs           (gh CLI + REST API wrappers via child_process/fetch: search, pr view, pr diff, post review w/ inline comments)
│   ├── state.mjs            (read/write state.json)
│   ├── reviewer-adapter.mjs (abstraction over the actual review-generating command; parses structured JSON findings)
│   ├── agent-detect.mjs     (probes PATH + auth status for known reviewer CLIs: claude, codex)
│   └── scheduler.mjs        (installs cron/launchd/Task Scheduler entries, with confirm-before-write)
└── .gitignore               (defensive local-runtime files, node_modules, .env, secrets)
```

## Per-user runtime state

All per-user runtime state lives outside this repository under the user home:
`~/.openmergelens/` by default, or the directory selected by the
`OPENMERGELENS_HOME` environment variable. This includes `config.json`,
`state.json`, `poll.log`, retained `reports/`, editable `docs/review-prompts/`
and `docs/learnings/` files, and the generated `scheduler-environment.json`.
The repository `.gitignore` still ignores local-runtime names such as
`state.json`, `state.json.lock`, `config.json`, and `poll.log` as a defensive
safeguard if someone deliberately points `OPENMERGELENS_HOME` at a checkout;
that does not make the repository root the normal storage location.

**Decided: Node, package-managed with pnpm.** Cross-OS is a hard requirement
(it must work on Windows without WSL/Git Bash/Cygwin). Bash doesn't run natively
on Windows, so it's ruled out. Node runs identically on Windows/macOS/Linux;
`gh` itself is still the one external prerequisite (already required either
way, since it's the GitHub interface). pnpm used for dependency install
(likely minimal deps: maybe none beyond Node built-ins) and for exposing the
poller as a `pnpm` script / bin.

## Core logic (one poll cycle)

1. **Discover candidate PRs.** For every configured account and every
   explicitly selected repository, search for open PRs that currently request
   that account's review. Validated search results are the only source of
   review candidates; locally tracked PR numbers never enter the queue by
   themselves. For each target:
   ```bash
   gh api --paginate --method GET /search/issues -f q="is:pr is:open review-requested:USERNAME repo:OWNER/REPO" -f per_page=100 --jq '"meta|" + (.total_count | tostring) + "|" + (.incomplete_results | tostring), (.items[] | .repository_url + "|" + (.number | tostring))'
   ```
   This covers both manual reviewer requests and requests GitHub created from a
   matching `CODEOWNERS` rule. Global search is intentionally unsupported:
   coverage must be explicit. Admission requires stable pagination metadata plus
   distinct candidate and page counts that agree with that metadata.
   Authentication failures, search failures, incomplete or capped results,
   inconsistent pagination, count mismatches, or any malformed/foreign row fail
   the complete account/repository scope closed.
   The paginated output starts each page with `meta|total_count|incomplete_results`
   and then emits newline-delimited `repository_url|number` pairs. Search results
   absent from a page are never authoritative evidence for deleting review state
   or scheduling cursors, because concurrent membership changes can preserve the
   reported count while moving an item across page boundaries. Historical state
   is retained but cannot enter the candidate queue or consume metadata budget.
   Review records expire locally after exactly 365 days. Before returning from
   a real poll, including an empty poll, rotating maintenance shares at most 25
   remote operations between exact marker proof and direct closure checks for
   historical records in selected, authenticated, configured
   account/repository scopes. It deletes closed state only for exact keys
   directly confirmed `CLOSED` or `MERGED`; search absence, lookup failure,
   malformed metadata, HTTP 404, and `OPEN` all retain state. Deconfigured and
   unscoped records receive only local expiry, never remote checks. A requested
   candidate confirmed closed or merged at initial fetch, after generation, or
   at the mutation boundary is also retired by exact key. Dry runs never mutate
   state.
   Global search is intentionally unsupported: coverage must be explicit.
   Resolve each account with `gh auth token --hostname ... --user ...` and
   scope every child command with that credential.

2. **Review candidates in bounded concurrent batches.** Build an independent
   queue per account, deduplicate validated requested candidates within that
   account, then round-robin its repository queues into one global queue.
   Process up to `reviewBatchSize` PRs
   concurrently across all accounts (default `5`), subject to a built-in
   admission cap of three reviews that bounds aggregate diff, gateway, prompt,
   and reviewer-process memory.
   For each candidate, get the current head commit SHA:
   ```bash
   gh pr view <N> --repo OWNER/REPO --json headRefOid,number,title,url
   ```

3. **Compare against state.json**:
   - Key: `HOST@USERNAME::OWNER/REPO#N`
   - If key absent → new PR, needs review.
   - If key present and stored SHA != current `headRefOid` → new commits since
     last review; if this PR was returned by the active requested-reviewer
     search, it needs re-review.
   - If key present and SHA matches → skip, already reviewed this exact head.
   - After `needsReview` succeeds, a real poll reserves the exact final record's
     canonical key, SHA, timestamp, entry count, and serialized UTF-8 bytes
     before marker reconciliation, diff fetch, prompt reads, or AI work. A dry
     run does not reserve persistence capacity.
   - If local state is missing, check the PR's submitted reviews for
     OpenMergeLens's opaque account/repo/commit marker. If found, repair local
     state and skip generation/posting. This closes the crash window between a
     successful GitHub POST and the following state write.

4. **For PRs needing review**, build the review prompt:
   - Fetch diff once for later deterministic finding-anchor validation:
     `gh pr diff <N> --repo OWNER/REPO`. Do not embed it in the reviewer prompt.
   - Fetch PR metadata (title, description, base/head branch) via `gh pr view`
   - Load the repository's user-editable prompt from
     `docs/review-prompts/<host>/<owner>/<repo>.md`. Accounts on the same host
     share it.
   - Load account-specific corrections from
     `docs/learnings/<host>/<username>/<owner>/<repo>.md`.
   - Compose a prompt roughly like:
     ```
     Perform a complete review of the linked pull request. Report every
     distinct, concrete, high-confidence issue you can substantiate. Do not
     stop after the first issue or impose an arbitrary findings limit.

     Use the structured OpenMergeLens inspection tool, backed by constrained
     host-side GitHub CLI reads, to inspect the complete cumulative PR diff and
     surrounding source. On a re-review, inspect every non-generated file and
     hunk, including code from earlier commits, as if it has not been
     reviewed before. For large PRs, inspect incrementally and maintain a
     coverage ledger instead of relying on one terminal rendering.

     Positively identify generated artifacts using repository evidence such as
     .gitattributes, generated headers, or generator configuration. Do not
     review confirmed generated output line by line; inspect its source of
     truth and validate that the tracked output is consistent. Never skip a
     file based only on its size or name.

     For each issue, output a structured entry: file, line, severity
     (critical/major/nit), and the comment text. See "Structured output
     format" below for the exact shape the adapter must return.

     ## Past learnings (adjust future reviews accordingly)
     <contents of the account/repository learnings file, if present>

     ## PR target
     <GitHub PR URL>
     ```

5. **Run independent reviewer passes** (agent-agnostic; see below) against the
   same PR URL. The reviewer receives a temporary structured MCP inspection
   tool, not the selected account credential. A parent-owned gateway validates every request
   as a GET against the fixed PR and repository before running the real `gh`
   command with the selected credential.
   The default pass set covers behavior and
   correctness, security and trust boundaries, integration and reliability,
   and tests plus an adversarial rescan. Each pass returns structured findings.
   A final synthesis invocation receives all candidate findings, independently
   re-inspects the linked PR through the same constrained MCP inspection
   tool/gateway, reconciles those candidates against the current cumulative PR,
   merges duplicate root causes, discards unsupported claims, and returns the
   one summary/findings result to post.
   Re-fetch metadata after review. If the PR is closed or merged, retire only
   that account's exact tracked key. If the head SHA changed during inspection,
   discard the stale result, report the candidate as deferred, and leave state
   untouched so the next poll retries against the new head. Revalidate that the
   exact configured user login is still in GitHub's requested-reviewer list;
   a revoked request skips posting, while a failed or malformed lookup fails
   closed without advancing state. If any pass or synthesis invocation fails
   or returns malformed output, skip posting and leave state untouched so the
   next poll retries.

6. **Post the review.** **Decided: formal GitHub PR review via the REST
   reviews endpoint**, not a plain issue comment. It shows up in the PR's review
   list, not just as a comment.
   **Decided: inline, severity-tagged comments** (one of the two adopted
   design suggestions below), posted as part of the same review object via
   `gh api` (the `gh pr review` CLI subcommand doesn't support per-line
   comments directly, so use the underlying REST API for a single review
   with multiple `comments[]` entries, each anchored to `path`+`line`,
   pulled from the adapter's structured findings):
   ```bash
   gh api --method POST /repos/OWNER/REPO/pulls/<N>/reviews \
     -f event=COMMENT \
     -f body="<review summary>" \
     -f "comments[][path]=<file>" -f "comments[][line]=<line>" \
     -f "comments[][body]=[<severity>] <comment text>"
   ```
   Event type defaults to `COMMENT` (never auto-`APPROVE` or
   auto-`REQUEST_CHANGES` without the user explicitly opting into that
   later because this is a review-comment bot, not an auto-approval bot). No
   confirmation gate: auto-approved per user's decision for this flow.
   Every review body carries a visible AI-generated attribution naming
   OpenMergeLens and the authenticated reviewer. The opaque marker remains
   only for idempotent reconciliation, not as the disclosure mechanism.
   Review POSTs are globally serialized with at least one second between
   mutations and pause according to GitHub rate-limit signals. Immediately
   before every POST, including the HTTP 422 summary-only fallback, re-fetch
   metadata and the requested-reviewer list and require the PR to be `OPEN`,
   the head to match, and the exact configured user request to remain active.
   Revocation is an expected no-post outcome; lookup failure fails closed.
   Read-only reconciliation is not a POST mutation and remains permitted after
   a successful or ambiguous POST, because GitHub may clear the request once a
   review is submitted.
   Findings the adapter couldn't anchor to a specific file/line fall back
   into the top-level review `body` (the summary), so nothing silently
   drops just because a line reference was missing. Include a deterministic,
   opaque HTML-comment marker in every review body. Retry the summary-only
   fallback only for a confirmed HTTP 422; on ambiguous transport errors,
   reconcile by listing reviews instead of issuing a second unsafe POST.

7. **If the reviewer adapter fails or returns empty** (**decided**): write a
   structured, account/PR-scoped failure record containing bounded, sanitized
   error metadata (including exit status and subprocess diagnostics) to the
   local log and skip posting anything: no comment, no review. Leave
   state.json unchanged for that PR so it's retried on the next poll instead
   of being silently marked as reviewed.

8. **Update state.json** with the new `headRefOid` for that PR key, so the
   same commit doesn't get re-reviewed next poll.

9. **Notify after the complete poll settles.** Desktop notifications are
   default-on with a config opt-out and use native macOS, Windows, and Linux
   facilities. Emit one audible notification when review
   work occurred or a failure needs attention; no-op and lock-contention runs
   stay silent. Identify up to three PRs by repository, number, and title,
   distinguish reviews, re-reviews, deferred outcomes (informational and not
   requiring attention), dry-runs, recoveries, and tracking failures, and
   prioritize failures in mixed results. Eligible notifications carry a
   private, bounded local HTML snapshot of that exact poll. Body activation
   and a View-results action open the snapshot on macOS and Windows; Linux
   exposes the action for a bounded 15-minute listener window when the desktop
   notification server supports it, with `openmergelens report` as the
   fallback. Reports retain only display metadata and canonical PR links,
   never review bodies, diffs, findings, or secrets.
   Notification delivery is best-effort, limited at its launch boundary, and
   can never change review state or the poll exit status.

10. **Selected-set AI-processing consent.** Repository selection alone is not
    authorization to send source code or PR data to a third-party reviewer.
    Configuration records one explicit top-level `aiProcessingConsent`
    attestation scoped to the complete repository set selected across all
    accounts and the shared reviewer backend. The setup wizard explains provider retention,
    training, confidentiality, data-residency, and DPA considerations and
    requires one bulk confirmation. Polling fails closed before authentication,
    search, or reviewer invocation when consent is absent.

## Structured output format (adopted design suggestion #1)

Prior-art research (CodeRabbit, Greptile, Bito, etc.) shows inline,
severity-tagged comments are the near-universal pattern: a single summary
comment (OpenMergeLens's original design) is lower-value than line-anchored
feedback. **Decided: adopt this.**

The reviewer adapter must return findings as JSON, not freeform prose, e.g.:

```json
{
  "summary": "One-paragraph overview of the PR and overall assessment.",
  "findings": [
    {
      "path": "src/foo.ts",
      "line": 42,
      "severity": "critical",
      "comment": "This mutates shared state without a lock, creating a race condition under concurrent requests."
    }
  ]
}
```

Severity levels: `critical` (bug/security, blocks merge), `major` (real
issue, should fix), `nit` (style/minor, optional). The reviewer-adapter
prompt must instruct the backend to emit exactly this shape (e.g. "respond
with JSON only, matching this schema: ..."); `lib/reviewer-adapter.mjs`
parses and validates it, falling back to treating the whole response as an
   unanchored `summary` finding if parsing fails. This degrades gracefully to
   a summary-only review instead of failing the poll outright.

## Learnings file (adopted design suggestion #2)

Prior-art research shows tools like CodeRabbit let reviewers reject/accept
AI suggestions, and that feedback shapes future reviews, thereby reducing repeat
false positives. **Decided: adopt a lightweight local equivalent.**

- `docs/learnings/<host>/<username>/<owner>/<repo>.md`: a free-form markdown
  file of durable notes ("don't flag X, it's intentional because Y"). The
  deterministic path prevents corrections learned for one reviewer identity
  or repository from contaminating another.
- Not auto-written by OpenMergeLens itself in v1. The user manually appends
  entries after noticing the bot repeat a bad suggestion. (Auto-capturing
  "user reacted 👎 to this comment" would require polling PR comment
  reactions, which is a reasonable future enhancement but out of scope for
  the initial implementation.)
- Loaded and inlined into every review prompt per step 4 above, so it
  compounds over time without any code change beyond editing a markdown
  file.

## Agent-agnostic reviewer adapter

The setup wizard writes the complete, isolated command for a detected Claude
or Codex backend. Do not copy a bare agent invocation (such as `claude -p`)
into `reviewerCommand`: custom commands are accepted only when they expose the
per-review MCP server through both placeholders. For a custom backend, define
the config field like:

```json
{
  "reviewerCommand": "my-reviewer --mcp-config {{mcp_config}} --allowed-tool {{mcp_tool}}",
  "reviewerInputMode": "stdin"
}
```

The reviewer contract is prompt-only: the adapter pipes the composed PR-link
prompt to `reviewerCommand` via stdin, the command uses only the constrained MCP
inspection tool to inspect the PR, and stdout contains structured review JSON.
The diff is fetched host-side for deterministic anchor validation and is never
embedded in reviewer input. Swapping to a different CLI (another agent
runtime, a different model wrapper, a local LLM harness) is a one-line config
change, not a code change. Reviewer commands that require a prompt file are not
supported by the current `reviewerInputMode` contract; use a small stdin-reading
wrapper when adapting such a backend.

For a built-in backend, run `openmergelens init` and keep the generated
`reviewerCommand`; it includes the MCP inspection contract and the required
read-only restrictions. Keep custom commands swappable by retaining both
`{{mcp_config}}` and `{{mcp_tool}}` placeholders.

## Config shape

```json
{
  "configVersion": 5,
  "aiProcessingConsent": null,
  "githubAccounts": [
    {
      "hostname": "github.com",
      "username": "work-account",
      "repositories": ["OWNER/socialpostai-v2"]
    },
    {
      "hostname": "github.com",
      "username": "personal-account",
      "repositories": ["OWNER/personal-project"]
    }
  ],
  "reviewerCommand": "my-reviewer --mcp-config {{mcp_config}} --allowed-tool {{mcp_tool}}",
  "model": null,
  "reviewerInputMode": "stdin",
  "reviewBatchSize": 5,
  "reviewFocusCount": 4,
  "reviewTimeoutMs": 1800000,
  "desktopNotifications": true,
  "stateFile": "./state.json"
}
```

This shape passes the current v5 validator. `openmergelens init` or
`openmergelens config` fills in the consent scope after the user confirms the
selected reviewer and repositories; the `null` value above is the valid
pre-consent state.

**Decided: repo name is `suguspnk/openmergelens`** for this bot's own repo (not
to be confused with `socialpostai-v2`, which is what it watches/reviews).
Repository targets are always explicit `OWNER/REPO` strings.

## State file shape (local-only user state)

`stateFile` supports an explicit absolute path. Relative values are resolved
under the user home described above, so the `"./state.json"` value in
`config.example.json` means `~/.openmergelens/state.json` by default (or the
corresponding path under `OPENMERGELENS_HOME`).

```json
{
  "github.com@antonio::owner/socialpostai-v2#123": {
    "lastReviewedSha": "abc123...",
    "lastReviewedAt": "2026-07-24T18:00:00.000Z",
    "reviewMarkerVersion": 1
  },
  "__openmergelens": {
    "version": 1,
    "candidateCursors": {
      "github.com@antonio::owner/socialpostai-v2::requested": 25
    },
    "reviewStateGcAfterKey": "github.com@antonio::owner/socialpostai-v2#123"
  }
}
```

The reserved `__openmergelens` entry is optional scheduler metadata, not a
review record. It advances bounded candidate windows independently per account,
repository, and discovery source when one poll cannot inspect every candidate.
Its optional `reviewStateGcAfterKey` cursor rotates the non-admitting historical
cleanup sweep. Marker-proof work rotates review-entry order deterministically:
each checked entry moves behind the other entries in its scope and each checked
scope moves behind the other scopes. Reordering adds no bytes at the state-file
ceiling, remains independent of closure cleanup, and keeps version 1 metadata
readable by earlier strict readers.

An unreleased intermediate build wrote two extra version 1 proof-cursor
fields. A non-dry poll accepts those fields once, converts their last position
to the byte-neutral entry order, and atomically saves predecessor-readable
metadata before authentication or GitHub work. If that migration save fails,
the poll stops with the original file untouched. Dry runs preserve their
no-write guarantee, so downgrade after encountering that intermediate state
requires one successful non-dry migration first.

The file is read with a 16 MiB pre-parse bound and can contain at most 10,000
review records. Scoped keys are canonical lowercase
`HOST@USERNAME::owner/repo#N`; the only compatible legacy form is lowercase
`owner/repo#N`, with case-only aliases normalized and one-account legacy state
adopted before external work. Host, user, repository, and positive decimal PR
segments are validated. Records reject unknown fields, limit SHAs to 128
characters, require canonical ISO timestamps no more than five minutes in the
future, and optionally carry only `reviewMarkerVersion: 1`. Invalid state is
left untouched and fails before authentication or GitHub work.

One shared serializer measures exact pretty-printed UTF-8 output for both
admission and the atomic temporary-file save. Configuration is limited to
10,000 canonical account/repository scopes independent of an account selector.
After initial metadata and `needsReview`, real polls reserve the candidate's
exact final key, SHA, timestamp, entry count, and bytes before marker
reconciliation, diff fetch, prompt reads, or AI; dry runs do not reserve.
Configured scopes have equal soft entry and byte shares and can borrow unused
global space. Under pressure, deterministic reclaim selects the largest
normalized overage then scope key, and the oldest timestamp then key within
that donor. It never crosses the constrained dimension's configured floor and
never evicts the current key, an active reservation, unscoped/invalid state, or
a record without exact marker proof; deconfigured scopes have zero floors.
Only an authenticated, nonpending, exact repo/PR/SHA marker can establish
`reviewMarkerVersion: 1`. Planning, pruning, reservation, and state commits are
serialized, and failed saves restore the complete in-memory batch.

Review records expire exactly 365 days after `lastReviewedAt`. This bounds
storage at the cost that an unchanged, still-requested PR can become eligible
again after expiry if its prior marker cannot be reconciled. The rotating
historical-maintenance budget remains 25 remote operations per real poll and is
shared by direct closure checks and marker proof; absence, malformed responses,
errors, and HTTP 404 retain the record.

## Scheduling

`node bin/poll.mjs` remains a one-shot script: no built-in daemon/loop
mode. **Decided: the interactive setup flows install the schedule**, not a
manual next-session step; `openmergelens init` and `openmergelens config` both
reconcile the selected schedule immediately. See **Onboarding** below for the exact flow
(cron / launchd / Task Scheduler, each with a confirm-before-write, or
"I'll do it myself" which only prints instructions). This section covers
what each option actually installs:
- Before configuring an installed OS schedule for the published package,
  install OpenMergeLens persistently, for example with
  `npm install -g openmergelens` (or `pnpm add --global openmergelens`), then
  run `openmergelens init` or `openmergelens config`. Do not use temporary `npx` or `pnpm dlx` runners to
  configure an installed schedule: the scheduler stores the resolved package
  path, and a later temporary-cache cleanup can remove it. Use `npx` or
  `pnpm dlx` only for manual, one-shot commands.
- Installed schedules invoke Node with the generated `bin/scheduled.mjs`
  runner and the generated `scheduler-environment.json` path. The runner loads
  the setup-time environment from that file before importing the one-shot
  `bin/poll.mjs` script.
- `cron` entry (macOS/Linux) runs `bin/scheduled.mjs` at an exact hourly
  cadence. The application logger writes structured records to the scheduler's
  `poll.log`; the entry also redirects stdout/stderr as a fallback for wrapper
  or early-startup output. Supported
  intervals are 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, and 30 minutes—the positive
  whole-minute intervals that divide an hour. Cron step expressions reset at
  each hour, so values such as 7 or 59 are rejected rather than producing a
  shorter boundary gap.
- `launchd` plist (macOS) sets the same Node, `bin/scheduled.mjs`, and
  `scheduler-environment.json` arguments, with its interval and output paths.
- Windows Task Scheduler entry invokes the hidden
  `bin/scheduled-win32.vbs` launcher, which passes Node,
  `bin/scheduled.mjs`, and `scheduler-environment.json` to the scheduled run.
  launchd and Task Scheduler accept positive whole-minute intervals from 1
  through 1439; this shared maximum matches Task Scheduler's `/mo` minute
  limit.
- For a manual one-shot, run `node bin/poll.mjs`; use
  `node bin/poll.mjs --dry-run` to exercise a poll without posting a review.
- Claude Code's `/loop` skill wrapping a shell invocation remains a manual
  option outside the wizard, if the user wants to drive it from inside a
  Claude Code session instead of OS-level scheduling

## Auth prerequisites

- `gh auth status` must show an authenticated account with `repo` scope
  (needed for REST review posting, `pr view`, and `pr diff` on private repos).
- Whatever `reviewerCommand` is configured must have its own auth already
  set up independently (e.g. `claude` CLI already logged in). The onboarding
  wizard (below) checks this at setup time so auth problems surface before
  the first poll, not silently as a failed/skipped review later.

## Onboarding (`openmergelens init`)

**Decided: an interactive setup wizard**, not a hand-edited config file.
Modeled on well-known CLI onboarding flows (`gh auth login`, `npm init`,
`create-next-app`, `stripe login`): short prompts, sensible defaults,
inline validation, ends in a real test run rather than a wall of docs.

**Library: `@clack/prompts`**. It is modern and cancel-safe (Ctrl-C cleanly aborts
mid-flow without leaving a half-written config), good default look
(rounded borders/spinners) without needing custom styling work.

For the published package, install it persistently before configuring an OS
schedule, then run `openmergelens init`:

```bash
npm install -g openmergelens
openmergelens init
```

A persistent pnpm global install (`pnpm add --global openmergelens`) is also
supported. Temporary `npx` and `pnpm dlx` runners are for manual, one-shot
commands only; do not use them to configure an installed OS schedule because
their cache path can disappear after cleanup. For cloned-checkout development,
run `node bin/init.mjs` as usual. Steps, in order:

1. **Welcome banner.** One line: name + one-sentence purpose. No ASCII art.

2. **GitHub reviewer account selection.** Runs `gh auth status`, lists every
   authenticated account, and asks for the complete set that should watch for
   requested reviews and post reviews. The wizard explains that a PR must be in
   GitHub's **Reviewers** list for the selected account; the request may be
   manual or supplied by a matching `CODEOWNERS` rule. Existing configured
   accounts are preselected.
   - No authenticated accounts → print the exact fix (`gh auth login`) and
     exit immediately.
   - Store only hostnames, usernames, and explicit repositories in config,
     never tokens.
   - Version 2 repository-scoped consent and version 3 and 4 configs are migrated
     conservatively. Older or unsupported shapes are rejected and require a
     fresh config from `openmergelens init`.
   - Resolve each account at poll time with
     `gh auth token --hostname ... --user ...` and pass the token only to
     child `gh` processes. Do not use
     `gh auth switch`, because it mutates global CLI state and races with
     other scheduled OpenMergeLens instances.

3. **Repository selection: explicit per account.** No global mode:
   - For each selected account, fetch every accessible repository:
     `gh repo list --json nameWithOwner,isPrivate --limit 200` (paginate if
     needed).
   - Render a searchable multi-select with existing repository choices
     preselected. Require at least one repository per account. Watching a
     repository enables the requested-review search; it does not create or renew
     GitHub review requests.

4. **Review files: deterministic and previewed.** Seed one prompt per
   host/repository and one empty learnings file per host/account/repository,
   but only after the final confirmation. Never overwrite existing files.

5. **Reviewer backend: detect known agent CLIs, offer custom as always
   available.**
   - Probe for known CLIs on `PATH` and check each is actually
     authenticated/working, not just installed:
     - **Claude Code** (`claude`): detect via `which claude`; verify
       working with a minimal non-mutating, prompt-only check supported by
       that CLI (or an equivalent lightweight ping) rather than assuming
       presence-on-PATH means ready.
     - **Codex CLI** (`codex`): detect via `which codex`; verify its
       authentication with `codex login status` (or the equivalent
       non-mutating status check). The generated reviewer command uses the
       same isolated execution family plus access to only the per-review local
       GitHub gateway, so scheduled execution
       does not depend on a Git working directory, does not retain five
       sessions per reviewed PR, and prevents model-generated commands from
       modifying local files.
   - Multi-select-style list showing each detected CLI with a status
     badge: `✓ ready`, `✗ found but not authenticated`, or not listed at
     all if not found on PATH. An entry marked "found but not
     authenticated" is still selectable: picking it prints the specific
     login command for that CLI (e.g. `claude /login`, `codex login`) and
     tells the user to run it, **then** re-checks before continuing, so
     auth happens right where the wizard flags it's missing, not as a
     mystery failure during the first poll.
   - **Custom command** option always shown regardless of detection
     results: free-text entry for `reviewerCommand` (any other CLI/script
     the adapter can shell out to). It must expose the per-review MCP server
     through explicit `{{mcp_config}}` and `{{mcp_tool}}` placeholders;
     commands without both placeholders fail closed before launch.
   - For a selected built-in backend, offer a current-only versioned model
     catalog plus a safe free-text model ID fallback. Offer the backend's
     native reasoning/effort choices when the installed CLI exposes the
     corresponding control; otherwise retain the CLI default. Persist these
     independent settings in the top-level `model` object, without including
     model changes in AI-consent scope or review-state identity.
   - Selection sets `reviewerCommand` (and `reviewerInputMode`) in config.
   - Config loading upgrades the exact former generated defaults (`codex exec`
     and the earlier read-only/no-network Codex command) to the safe
     read-only-filesystem, local-gateway command above. Commands already
     customized by the user are never rewritten.

6. **Review focus coverage.** Ask how many independent review focus
   categories to run before synthesis:
   - 4: behavior/correctness, security/trust boundaries,
     integration/reliability, and tests/adversarial rescan (recommended)
   - 3, 2, or 1: progressively fewer categories and fewer reviewer calls
   The selection sets `reviewFocusCount` and the final config preview explains
   the resulting reviewer-call count. On rerun, default to the existing value
     when it is valid. `reviewTimeoutMs` is a config-editor setting for the
     per-reviewer-process timeout; init preserves an existing value without
     prompting for it.

7. **Scheduling.** Select one:
   - `cron` (macOS/Linux)
   - `launchd` (macOS, preferred over cron because it survives reboots better)
   - Windows Task Scheduler
   - "I'll do it myself": prints the equivalent manual snippet/steps for
     whichever platform the user is on and does nothing further.

   **Decided: for the first three, OpenMergeLens installs the entry itself**
   and writes the crontab line, launchd plist plus `launchctl load`, or Task
   Scheduler entry rather than merely printing instructions. Because this is a
   standing OS-level configuration change made on the user's behalf, the
   wizard must show the **exact entry it's about to write** (full crontab
   line, full plist contents, or full Task Scheduler XML plus its `schtasks
   /xml` registration command) and get an
   explicit final yes/no at that step, immediately before writing;
   picking "cron" earlier in the menu is not itself the confirmation.
   "I'll do it myself" skips this entirely; nothing is written to the OS.

   Cron accepts only 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, or 30 minutes so its
   minute-step expression keeps the requested cadence across hour boundaries.
   launchd and Windows Task Scheduler accept positive whole-minute intervals
   from 1 through 1439; scientific notation, unsafe integers, and values above
   that maximum are rejected before preview or installation.

8. **Summary + confirm.** Preview config, deterministic review-file paths,
   and the one shared schedule. Ask once before applying file/config/schedule
   writes. If the user declines, leave configuration and review files
   unchanged.

9. **Success screen.** Print the command to do a complete dry run and an
   account-filtered example using `--account USERNAME@HOSTNAME`, e.g.
   `node bin/poll.mjs --dry-run` (composes prompts and calls the reviewer
   adapter, but skips the actual REST-backed GitHub review post), so onboarding ends at
   "see it produce real output," not "trust it blindly."

Validation happens inline at each step (e.g. repo names checked live via
the `gh repo list` fetch in step 3, not deferred to a final check), so a
mistake is caught where it's made rather than surfacing as a cryptic
failure three steps later.

## Existing configuration editor (`openmergelens config`)

After setup, the configuration editor loads and validates the existing
`config.json`, requires a real interactive terminal, and holds the same
operation lock as polling and `init`. It presents grouped menus for accounts
and repositories, reviewer backend/model, review behavior, notifications, and
scheduling, plus a read-only current-configuration view.

Every completed config change is validated and written immediately through the
same atomic config writer; the editor remains open for subsequent changes.
Account and repository changes reuse GitHub authentication and repository
selection, require fresh AI-processing consent when the reviewer command or
selected scope changes, and create only missing prompt/learnings files. Removed
watches leave those files untouched. Notification enablement runs the existing
test-notification flow. Schedule changes reconcile the OS scheduler immediately
and preserve the prior schedule when rollback is reliable; scheduler state is
operational state outside `config.json`. Prompt and learnings content remains
editable as files, not through this menu.

## Decisions (resolved)

All open items from spec drafting are now resolved:

1. **Language: Node, managed with pnpm.** Bash was ruled out: it doesn't run
   natively on Windows, and cross-OS support (no WSL/Git Bash requirement) is
   a hard requirement. Node runs identically on all three OSes.
2. **Bot repo name: `suguspnk/openmergelens`.** Still need the actual
   `OWNER/socialpostai-v2` slug for the *watched* repo: check `git remote -v`
   there at implementation time.
3. **Search scope: explicit per account.** Global search is unsupported.
4. **Error handling:** log failure details, skip posting, leave state
   unchanged so it retries next poll.
5. **Post format: formal GitHub PR review through the REST reviews endpoint**,
   not a plain issue comment, so it is visible in the PR's review list.
   **Refined further per prior-art research:** inline, severity-tagged comments
   via the REST API's `comments[]` entries, not a single review body; see
   **Structured output format** above.
6. **Prompt source: OpenMergeLens's own bundled template**, seeded into a
   directly editable host/repository prompt path.
7. **Prior-art research done** (competitive scan of CodeRabbit, Qodo/PR-Agent,
   Sourcery, DeepSource, Greptile, Hermes Agent, etc.; see conversation
   history). Confirmed no existing product does local-polling +
   no-GitHub-App + BYO-LLM the way OpenMergeLens does; two design patterns
   adopted from the scan:
   - **Inline, severity-tagged comments** instead of a single summary
     comment (near-universal pattern across commercial tools).
   - **Account/repository learning files** are inlined only into that
     identity's prompt, so corrections compound without cross-account
     contamination.
8. **Onboarding UX designed** (`openmergelens init`, see full section above):
   interactive wizard using `@clack/prompts`. Key resolved sub-decisions:
   - GitHub account selection is a multi-select; every selected identity owns
     an independent explicit repository list.
   - Repo selection is a searchable multi-select of accessible repos for each
     account, with no global mode.
   - Reviewer-backend step **detects known agent CLIs** (Claude Code,
     Codex) on PATH and **checks each is actually authenticated**, not
     just installed: surfacing the specific login command inline if not.
     A free-text **custom command** option is always available alongside
     detected CLIs.
   - Scheduling: wizard **installs** the cron/launchd/Task Scheduler entry
     itself (not just instructions) for those three options, but shows the
     exact entry and requires a final explicit confirm immediately before
     writing it, since it's a standing OS-level change. "I'll do it
     myself" only ever prints instructions, no OS write.
   - Prompt/learnings paths are deterministic rather than configurable:
     prompts are shared per host/repository and learnings are isolated per
     host/account/repository.

## Multi-account operational decisions

- One account's auth failure never blocks healthy accounts; account,
  repository, and candidate failures are logged and make the final exit
  nonzero after independent work completes.
- The same PR can be reviewed independently by multiple requested identities.
- One shared state file uses hostname/username-namespaced keys.
- One global `reviewBatchSize` is enforced across a round-robin account queue,
  with a built-in three-review resource admission cap.
- One process lock prevents overlapping polls and blocks `init` while polling.
- Removing an account or repository stops polling it but retains its prompt,
  learnings, and state for safe reactivation.

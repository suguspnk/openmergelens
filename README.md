# OpenMergeLens

**A local CLI that automates AI code reviews for GitHub and Bitbucket Cloud pull requests using
Codex, Claude Code, or any compatible MCP-enabled reviewer CLI.**

[Website](https://suguspnk.github.io/openmergelens/) ·
[npm](https://www.npmjs.com/package/openmergelens) ·
[Quick start](#quick-start) ·
[Get help](https://github.com/suguspnk/openmergelens/discussions)

OpenMergeLens runs on your own machine on a schedule (cron / launchd / Windows
Task Scheduler). It requires no GitHub App, Bitbucket app, webhook, or server. It uses `gh` or the
Bitbucket Cloud REST API to find
open PRs where one of your configured accounts has an active review request. The
request can be added manually or created automatically by a matching
[CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
rule. A compatible reviewer CLI (Codex, Claude Code, or a custom MCP-enabled
command) then generates an inline, severity-tagged GitHub review.

Start with a dry run, review its output, and only then enable posting.

Full design rationale lives in [PRD.md](./PRD.md). This doc is just
setup.

## Why OpenMergeLens

- **Keep review execution local.** Your configured reviewer runs on your
  machine; OpenMergeLens does not require a hosted review service, GitHub App,
  webhook, tunnel, or repository workflow YAML.
- **Use the reviewer you already trust.** Choose Codex, Claude Code, or a
  compatible MCP-enabled command without coupling the polling workflow to one
  model vendor.
- **Adapt reviews to each repository.** Every watched repository gets an
  editable review prompt, so its checklist and priorities can match the code
  instead of a global generic policy.
- **Teach later reviews.** Durable learnings are isolated by GitHub identity
  and repository, keeping corrections relevant to the right reviewer and
  codebase.
- **Inspect before posting.** Dry-run mode performs discovery and review
  without GitHub mutations. Real runs validate inline anchors against the
  actual diff and move unanchored findings into the summary.

## Quick start

With [Node.js](#prerequisites), an authenticated GitHub CLI, and an
authenticated reviewer CLI already available:

```bash
npm install -g openmergelens
openmergelens init
openmergelens --dry-run
```

The wizard selects the GitHub accounts and repositories to watch, confirms
one explicit AI-processing consent for all selected repositories, detects your reviewer, and
offers an operating-system schedule. The dry run fetches and reviews matching
pull requests without posting anything to GitHub.

When the output looks right, run `openmergelens` once to post real reviews.
For setup questions, use
[GitHub Discussions](https://github.com/suguspnk/openmergelens/discussions);
for reproducible defects, use the
[bug report form](https://github.com/suguspnk/openmergelens/issues/new?template=bug.yml).

## When a PR is reviewed

OpenMergeLens reviews an open PR only when all of these are true:

- The repository is explicitly selected in `openmergelens init`.
- A configured GitHub account appears in the PR's **Reviewers** list as a
  requested reviewer.
- The scheduled poll reaches the PR while that request is active.

The reviewer request may be added manually by someone with permission to request
reviews, or GitHub may add it automatically when a matching `CODEOWNERS` rule
applies. OpenMergeLens does not review every PR in a watched repository, infer
requests from labels or mentions, or create reviewer requests itself. See GitHub's
[requesting a pull request review](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/requesting-a-pull-request-review)
and [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
documentation for the GitHub-side setup.

After OpenMergeLens reviews a PR, pushing another commit does not start a
re-review by itself. The PR author must request the configured account again in
the PR's **Reviewers** list. Once GitHub shows that fresh request, the next poll
can review the new head commit; the local SHA state prevents the same commit from
being reviewed twice.

## Prerequisites

Before running anything, make sure you have:

1. **Node.js 22.14+ in the Node 22 line or Node.js 24.x**
   ```bash
   node --version
   ```
2. **For GitHub repositories: GitHub CLI (`gh`), authenticated**
   ```bash
   gh auth status
   ```
   If this fails, run `gh auth login` first. Multiple authenticated accounts,
   including accounts on different GitHub hosts, can run together. A
   Bitbucket-only setup does not require `gh`.
3. **A reviewer CLI**, already logged in on its own: pick one:
   - [Claude Code](https://claude.com/claude-code): `claude /login`
   - [Codex CLI](https://github.com/openai/codex): `codex login`
   - For GitHub-only configurations, a custom CLI that can read a prompt from
     stdin, print text/JSON to stdout, attach a per-run MCP server, and restrict
     access to the named MCP inspection tool.

## Install

```bash
npm install -g openmergelens
```

Or install it globally with pnpm:

```bash
pnpm add --global openmergelens
```

Or skip the install and run it on demand with `npx`:

```bash
npx openmergelens init
```

Useful command metadata is available without configuration:

```bash
openmergelens --help
openmergelens --version
```

Config, poll state, logs, retained review reports, and your editable per-repo
review prompts/learnings files all live under `~/.openmergelens/` (on POSIX,
override with the `OPENMERGELENS_HOME` env var), not inside the package install, so
they survive upgrades and don't need write access to wherever npm put the
package.

If you want scheduling (cron/launchd/Task Scheduler) to keep working long
term, install with `npm install -g` rather than running through `npx`;
`npx` without a global install can run from a temporary cache location that
gets cleaned up, breaking the scheduled entry.

## Set up (interactive wizard)

```bash
openmergelens init
```

This will:
1. Ask whether to configure GitHub, Bitbucket Cloud, or both. Fresh setup
   defaults to GitHub; Bitbucket-only setup works without `gh`.
2. Detect Claude Code / Codex on your `PATH` and check whether each is
   actually authenticated (not just installed). Bitbucket requires the
   generated Codex or Claude backend. GitHub-only setup may instead use a
   compatible custom reviewer command. Codex runs in ephemeral, read-only mode.
   For a generated backend, choose its model and reasoning/thinking effort (or
   keep either setting at the CLI default) before configuring provider accounts.
3. For GitHub, list authenticated `gh` accounts. For Bitbucket Cloud, ask for
   the exact username of a stored noninteractive `bitbucket.org` Git credential,
   verify it with `/2.0/user`, and derive the stable braced account UUID. You
   can add multiple Bitbucket accounts; existing configured accounts are
   preselected and reverified.
4. For every retained account, show accessible repositories as a searchable
   multi-select. Bitbucket first lists the authenticated user's workspaces, then
   lists member repositories within each workspace; it never falls back to the
   deprecated account-wide repository endpoint. Every account must explicitly
   watch at least one repository.
   Watching a repository enables requested-review discovery; it does not add a
   reviewer to a pull request automatically.
5. Require one explicit consent for the complete selected repository set
   before source code, pull-request content, or personal data can be processed
   by the selected third-party AI provider. Declining leaves setup unchanged.
6. Ask how many independent review focus categories to run per PR. The
   recommended choice runs all four categories plus synthesis; lower choices
   reduce reviewer calls by skipping later categories.
7. Ask whether completed polls should show desktop notifications (enabled by
   default).
8. Offer one schedule for the complete multi-account poller.
9. Preview the config, deterministic review-file paths, and schedule, then ask
   once before applying them. Declining leaves the config and review files
   unchanged.
10. After confirmation, seed shared prompts under
    `~/.openmergelens/docs/review-prompts/<host>/<owner>/<repo>.md`. Learnings
    are account-specific: GitHub uses
    `~/.openmergelens/docs/learnings/<host>/<username>/<owner>/<repo>.md`, while
    Bitbucket uses
    `~/.openmergelens/docs/learnings/bitbucket.org/<account-uuid>/<workspace>/<repo>.md`.
    Existing files are never overwritten. The wizard then saves the config,
    applies the selected schedule, and, when notifications are enabled, sends a
    test notification with platform-specific recovery guidance if it is
    suppressed.

Cancelling before the final confirmation leaves the config and review files
unchanged.

## Edit configuration

After setup, use the interactive editor instead of rerunning the full wizard:

```bash
openmergelens config
```

The editor groups accounts and repositories, reviewer backend and model, review
behavior, notifications, and scheduling. Each completed change is validated
and saved immediately, then the menu remains open for another change. Account
and repository edits reuse the provider-specific authentication and searchable
repository selection. You can edit or remove either provider's watches while
preserving the other provider; the last configured provider account cannot be
removed. Bitbucket edits require a generated Codex or Claude backend, and a
configuration containing Bitbucket watches cannot switch to a custom backend.
Newly watched repositories get missing prompt and learnings files without
overwriting existing files. Removed watches stop being polled but keep their
files. Schedule changes reconcile the installed cron, launchd, or Windows
Task Scheduler entry immediately; the scheduler choice and interval remain
operational state outside `config.json`.

### Setting up by hand instead

If you'd rather skip the wizard, write `~/.openmergelens/config.json` yourself.
A template is bundled with the package: find it with:

```bash
# npm global install
npm root -g

# pnpm global install
pnpm root -g
```

After running the command for the package manager you used, copy
`<that path>/openmergelens/config.example.json` to
`~/.openmergelens/config.json` and fill in the fields:

| Field | Meaning |
|---|---|
| `configVersion` | Required schema version; currently `6`. Version 5 GitHub-only configs load in memory with an empty Bitbucket account list; older supported versions are migrated conservatively. |
| `githubAccounts` | Array of `{ hostname, username, repositories }`. Each repository list contains explicit `OWNER/REPO` strings. May be empty when Bitbucket is configured. |
| `bitbucketAccounts` | Array of Bitbucket Cloud `{ accountId, credentialUsername, repositories }` records. `accountId` is the stable braced UUID returned by `GET /2.0/user`; repositories are explicit `WORKSPACE/REPO` strings. Bitbucket Data Center/Server is not supported. |
| `aiProcessingConsent` | A setup-generated scoped authorization covering all repositories selected across every configured account for the configured reviewer backend. Missing, `null`, malformed, or scope-mismatched consent prevents every repository from reaching the reviewer. Changing the backend or selected set requires one fresh bulk confirmation. Leave this `null` in hand-written config, then run `openmergelens init` or `openmergelens config` to record consent. |
| `reviewerCommand` | Agent command that reads a prompt on stdin, uses the provided MCP inspection tool, and prints review JSON on stdout. Generated Codex/Claude commands are configured automatically. A custom command must include both `{{mcp_config}}` and `{{mcp_tool}}` in the appropriate MCP-config and allowed-tool arguments; OpenMergeLens fills them per review and rejects custom commands without this explicit contract. |
| `model` | Optional object controlling the selected generated Codex/Claude backend. `null` uses both CLI defaults. Otherwise use `{ "id": "…", "reasoningEffort": "…" }`; either property may be `null` independently. Model IDs are validated before being added to the command. Custom reviewer commands must leave this field `null`. |
| `reviewBatchSize` | Configured upper bound for concurrent PR reviews across all accounts (defaults to `5`). A built-in memory admission cap of three reviews also applies. |
| `reviewFocusCount` | Number of independent review focus categories to run before the final synthesis pass (defaults to `4`, maximum `4`). The onboarding wizard asks for this; lower values skip later categories to trade coverage for runtime. |
| `reviewTimeoutMs` | Maximum runtime for each reviewer process (defaults to `1800000`, 30 minutes; accepts `60000` through `3600000`). `openmergelens config` can update it in the Review behavior menu; `init` preserves an existing value. |
| `reviewAttribution` | Optional per-repository map controlling the visible “OpenMergeLens generated this review” attribution. Attribution defaults to `true`; set a provider-qualified repository such as `"bitbucket.org/WORKSPACE/REPO": false` to hide it. This manual option is not shown in the interactive wizard. Non-rendering reconciliation markers remain in the raw comment either way. |
| `desktopNotifications` | Show one audible desktop notification after a poll produces review results or needs attention (defaults to `true`). Set to `false` to opt out. |
| `stateFile` | Where last-reviewed commit SHAs are tracked (defaults to `./state.json`, resolved under `~/.openmergelens/`). |

For example, this disables the visible attribution only for one Bitbucket
repository; every unlisted repository remains enabled:

```json
"reviewAttribution": {
  "bitbucket.org/mwell-systems/mwell-healthpal-cms": false
}
```

`~/.openmergelens/config.json` is local, machine-specific config. It is never
committed to a repo. It stores hostnames and usernames, never tokens. Each poll
retrieves every selected GitHub account's token from the GitHub CLI credential store.
For Bitbucket Cloud, configure a noninteractive HTTPS credential in Git's credential
store for `bitbucket.org` first, then select **Bitbucket Cloud** in
`openmergelens init` or under **Accounts & repositories** in
`openmergelens config`. Enter the exact credential username; the wizard verifies
the credential with `/2.0/user`, derives the stable account UUID, and lets you
search and select accessible member repositories. OpenMergeLens invokes
`git credential fill` and never writes the returned token to config, state, logs,
reviewer arguments, or the reviewer environment. Each poll verifies that
`/2.0/user` still returns the configured `accountId`. The reviewer never receives
provider credentials. For GitHub,
OpenMergeLens exposes one
temporary structured inspection tool backed by a per-review local gateway
that permits only GET operations for the fixed PR and its repository. The
generated Codex command denies host-file reads outside its isolated workspace,
has no direct network access, and fails closed on unknown configuration.

With a Git credential helper already configured, store the Bitbucket API token
without placing it in shell history by running `git credential approve`, typing
the following records at its stdin, and then entering a final blank line:

```text
protocol=https
host=bitbucket.org
username=reviewer@example.com
password=<Bitbucket Cloud API token>
```

Enter the same username when the wizard asks for the Bitbucket credential
username. OpenMergeLens never prompts during a poll: a missing helper entry fails
that account closed.

Create the Bitbucket Cloud API token with these exact permission scopes:
`read:user:bitbucket`, `read:workspace:bitbucket`,
`read:repository:bitbucket`, `read:pullrequest:bitbucket`, and
`write:pullrequest:bitbucket` (required for posting reviews). Older tokens that
lack `read:workspace:bitbucket` can return HTTP 403 during setup; recreate the
token with all five scopes and rerun `openmergelens init` or
`openmergelens config`. A repository HTTP 404 or 410 means the selected
workspace is no longer discoverable; the wizard leaves the existing
configuration unchanged.

Manual JSON configuration remains available as an alternative. Obtain `accountId`
from the authenticated Bitbucket Cloud `GET https://api.bitbucket.org/2.0/user`
response and copy its `uuid` exactly, including braces. Starting from the bundled
full example, replace the two provider account fields with this Bitbucket-only
account section:

```json
{
  "configVersion": 6,
  "githubAccounts": [],
  "bitbucketAccounts": [{
    "accountId": "{123e4567-e89b-42d3-a456-426614174000}",
    "credentialUsername": "reviewer@example.com",
    "repositories": ["workspace/repository"]
  }]
}
```

The account must appear in each pull request's Bitbucket **Reviewers** list.
OpenMergeLens posts individual inline comments and a completion summary; it does
not call Bitbucket's approval endpoint. `--dry-run` performs reads and reviewer
execution but does not post comments or update state.
Tracked Bitbucket entries may reconcile a completion comment after a failed
state write, but they never trigger a new review or comment unless the stable
reviewer UUID is present in the current discovery result. Before the first
comment mutation, OpenMergeLens saves an immutable per-commit posting plan in
the private state file; an interrupted retry reuses that exact plan. If the
reviewer request is removed, the plan is retained for seven days so a renewed
request can safely resume it. After that observed-unrequested window, the plan
is retired into a terminal handled-head record: the plan quota is reclaimed,
but that same head is not reviewed again for the 30-day terminal retention
window, preventing duplicate partial posts. Terminal records are capped at
10,000. If every slot is still within that window, an expired plan remains in
its bounded posting-plan map until a terminal slot can be reclaimed rather than
dropping the fail-closed same-head guard.
Provider diffs that cannot fit safely in one reviewer prompt are covered as
deterministic contiguous byte-range chunks, synthesized per chunk, and then
merged in one bounded final pass. No diff bytes are silently truncated; an
editable provider template may contain at most one `{{diff}}` placeholder.
Bitbucket review prompts currently use the generated Codex or Claude backend;
custom MCP-placeholder commands remain supported for GitHub configurations.
The setup and config wizards include the complete GitHub-plus-Bitbucket repository
scope when they request renewed AI-processing consent.

## Logs and diagnostics

OpenMergeLens writes newline-delimited JSON records to
`~/.openmergelens/poll.log` (or the configured `OPENMERGELENS_HOME`). Each
record includes a timestamp, level, event, run ID, safe operational context,
and a sanitized message. Failures also retain bounded error metadata such as
exit status and subprocess diagnostics. Unknown fields, raw credentials, and
unbounded command output are not written to the log.

Manual runs show a readable progress view on the terminal. Scheduled runs
write structured records to the file without echoing a second copy to stderr;
the scheduler's stdout/stderr redirection remains a fallback for unexpected
startup output. The active log is capped at 5 MiB and rotates through three
private backups (`poll.log.1` through `poll.log.3`). At startup, an existing
file containing legacy or unexpected non-JSON lines is moved through that same
private rotation before new JSONL records are written, so old diagnostics are
retained without breaking structured inspection of the active log.

For example, to inspect recent failures with `jq`:

```bash
jq 'select(.level == "error" or .level == "fatal") | {timestamp, event, runId, message, error}' \
  ~/.openmergelens/poll.log
```

## Try it (dry run)

Before trusting OpenMergeLens to post anything, run it in dry-run mode. This does
everything: search, diff fetch, invoke the reviewer agent against the linked
PR, and validate findings against the fetched diff, but
stops short of posting to GitHub:

```bash
openmergelens --dry-run
```

To exercise only one configured identity:

```bash
openmergelens --dry-run --account work-account@github.com
```

You should see one block per matching requested-review PR with a summary and
finding count.
Each review runs four independent focused passes plus a final synthesis pass by
default. Each reviewer process has a 30-minute timeout by default; the manual
`reviewTimeoutMs` setting can adjust that bound.
Host-side operations use `gh` for PR search, authentication, and
metadata/diff fetch; each reviewer pass inspects the linked PR through the
constrained `openmergelens.inspect_github_pr` MCP tool. The multiple passes can
make a dry run take longer than a single reviewer invocation.
If a PR is already up to date in `~/.openmergelens/state.json`, it's skipped and
logged as such.

## Run for real

```bash
openmergelens
```

This posts an actual GitHub PR review (inline comments + summary) for every
PR returned by a successful, completeness-proven search for an active review
request, provided the head commit has not already been reviewed by that identity.
Locally tracked PRs are never added to the queue on their own. The queue is
round-robin across accounts and repositories and uses the configured
`reviewBatchSize` as an upper bound, with a built-in cap of three admitted
reviews to bound aggregate review memory. Set `reviewBatchSize` in
`~/.openmergelens/config.json` to change the configured upper bound; raising it
cannot exceed the admission cap. On
success, it records the reviewed SHA in
`~/.openmergelens/state.json` so the same commit isn't re-reviewed next run.
The request may be manual or generated by `CODEOWNERS`. Search pagination
metadata and the distinct candidate count must agree before results are trusted.
Incomplete or capped Search results, inconsistent discovery, and any malformed
or foreign row fail the whole repository scope closed and admit no review
candidates. Historical state and scheduling cursors are retained when a PR is
absent from Search; they never enter the queue themselves or consume metadata
budget. OpenMergeLens revalidates the exact, case-insensitive requested-reviewer
login after generation and immediately before every review POST, including a
summary-only fallback. The configured reviewer must be a human GitHub login;
bounded unrelated `Bot` actors ending in `[bot]` may coexist in the reviewer
list, while malformed, padded, mistyped, or unknown actor rows fail the whole
authorization check closed. If the request is revoked, posting is skipped and
state is left untouched. Read-only reconciliation after an ambiguous or
successful POST remains allowed even though GitHub clears a fulfilled review request.
A requested PR that is fetched and found closed or merged is retired, including
when closure is confirmed after generation or at the mutation boundary.
Dry runs never change state.
State keys include the selected GitHub account, so two accounts can review
the same PR independently. Reviews also carry an opaque hidden marker; if a
post succeeds but the local state write fails, the next poll reconciles the
existing review instead of posting a duplicate.
When a repository has more candidates than one poll's bounded metadata budget,
the same state file also stores a reserved `__openmergelens` scheduling cursor
so overflow candidates rotate into later polls instead of starving behind a
stable prefix. Metadata-window overflow is reported as a deferred outcome, not
as a poll failure.

Review records expire 365 days after their canonical `lastReviewedAt`
timestamp. Timestamps more than five minutes in the future, malformed keys,
noncanonical PR numbers, and unknown record fields invalidate the complete
state file before authentication or GitHub work. Each real poll spends at most
25 deterministic, rotating historical-maintenance operations across direct
closure checks and exact hidden-marker proof. It deletes closed records only
when the matching PR is directly confirmed `CLOSED` or `MERGED`; search
absence, lookup failure, malformed metadata, and HTTP 404 are never deletion
evidence. Deconfigured or unscoped records are eligible only for the local
365-day expiry, not remote cleanup.

The state file is limited to 10,000 review records and 16 MiB, and configuration
is limited to 10,000 canonical account/repository scopes. After initial PR
metadata proves that a review is needed, a real poll reserves the candidate's
exact key, SHA, canonical timestamp, record count, and serialized UTF-8 bytes
before marker reconciliation, diff fetch, prompt reads, or reviewer work. Dry
runs make no persistence reservation. At pressure, configured scopes receive
equal soft entry and byte shares but may borrow unused global capacity.
Compaction is deterministic and may reclaim only oldest records carrying
`reviewMarkerVersion: 1`, which proves an exact authenticated, nonpending review
marker for that repo, PR, and SHA. Current, reserved, unscoped, malformed, and
unproven records are never evicted; deconfigured scopes have zero protected
share. Every compaction and review save is atomic and rolls back in memory if
persistence fails before commit. A failure after the namespace rename is
explicitly indeterminate: polling strictly reloads the committed path before a
later queued write, and disables further writes for that poll if reload cannot
reconcile it. On POSIX, an absolute `stateFile` remains
supported under a current-user-owned parent that is not group/other-writable
(including conventional `0755` directories); writable shared parents fail
closed. Windows cannot portably verify arbitrary ACLs or reparse points through
Node, so `OPENMERGELENS_HOME` must remain the canonical per-user default and
`stateFile` must name a direct file in that directory. Existing Windows
overrides must be relocated there before upgrading. Windows device aliases,
including superscript `COM`/`LPT` forms, alternate streams, and names ending in
a dot or space are rejected before path resolution. State bytes and the parent
directory are flushed around atomic rename.
When a supported Windows Node runtime reports an unavailable pathname volume
field but a positive file index, the verified canonical volume root from
`realpath` is used only for the path-to-path proof; mixed
available/unavailable identity observations and missing canonical roots still
fail closed.
On Windows, retained-temporary capacity reservations use a parent-scoped
guard before inspecting or creating the retention marker, so stale-marker
reclamation cannot race another OpenMergeLens contender. A guard whose owner
process has disappeared is intentionally fail-closed and must be removed by
an operator after confirming no save is active; this bounded recovery path
avoids guessing about PID reuse or deleting a newer guard pathname.
If the directory flush fails after rename, the committed state is retained and
the poll emits a durability warning instead of rolling memory back; unsupported
Windows directory flushes are reported through that same warning path. The
writer also rebinds the configured parent and committed file identities after
rename so a final-boundary parent replacement cannot report success.
One-time predecessor repair may read and atomically preserve up to 32 MiB; its
byte-neutral progress saves use compact JSON until the state fits the ordinary
pretty-printed 16 MiB limit. Repair authentication and lookups share a 15-second
deadline. On POSIX, an authentication process that ignores graceful termination
is force-killed with its process tree after a bounded grace period even if its
leader exits first. On Windows, forced tree termination starts immediately at
the timeout boundary, before the leader PID can exit and orphan descendants;
failure of `taskkill /t /f` is surfaced rather than reported as successful.

Every posted review includes a visible notice that it was generated by
OpenMergeLens using AI on behalf of the authenticated reviewer. Reviews remain
non-binding `COMMENT` reviews; OpenMergeLens never approves a PR or requests
changes automatically.

If one account, repository, or PR fails, OpenMergeLens logs a structured,
account- and PR-scoped failure, continues all independent work, and exits
nonzero after the poll. It
never posts a broken or empty review, and leaves failed PR state untouched so
the next run retries automatically. A global operation lock prevents
overlapping polls from duplicating reviews; a second poll logs that one is
already active and exits successfully. Fatal startup failures are also written
to `~/.openmergelens/poll.log`, including on Windows where the scheduler does not
redirect process output.

If new commits arrive while a review is running, OpenMergeLens discards the
stale result without posting it, reports the PR as deferred rather than failed,
and leaves its state untouched so the next poll reviews the new head.

## Desktop notifications

When a poll reviews, re-reviews, defers, dry-runs, or recovers one or more PRs,
OpenMergeLens sends one audible desktop notification after the complete batch
and all state writes finish. The notification lists up to three
`OWNER/REPO#N: title` entries and summarizes any remaining entries. Mixed
results are presented as an attention notification, with failed PRs
prioritized and successful PRs still represented.

When a notification contains PR results, click its body or choose **View
results** to open that poll's exact report in the default browser. Reports are
self-contained local HTML files: they include outcome, repository/PR number,
title, a short failure note when relevant, and the GitHub link when available.
They never include review bodies, diffs, findings, credentials, or tokens.
macOS and Windows support body activation. Linux offers the action when the
installed `notify-send` and desktop notification server support actions;
the activation listener remains available for up to 15 minutes so recurring
polls cannot accumulate long-lived processes. Desktops that ignore
notification actions still display the normal preview.

Open the newest retained report or choose an older one from an interactive
newest-first picker:

```bash
openmergelens report
openmergelens report --list
```

When `--list` is used from a pipe, scheduler, or other non-interactive
environment, it prints the retained reports instead of waiting for input or
opening a browser. Reports use private file permissions and are retained for
30 days, with at most 100 active snapshots. An old notification whose snapshot
was pruned opens a small expiry page rather than a newer report.

No notification is sent when there is no work or when another poll owns the
operation lock. Notification delivery is best-effort: helper launches are
bounded, failures are logged to `~/.openmergelens/poll.log`, and notification
delivery never changes a review or state outcome. On macOS 13 and later,
OpenMergeLens includes a universal build of the maintained `alerter` project
inside a dedicated OpenMergeLens application bundle, so review text is
attributed to OpenMergeLens rather than another trusted application and uses
the same official mark as the project website. These notifications have no
automatic timeout; they remain in Notification Center until dismissed, and a
newer OpenMergeLens alert replaces the previous one. Select **Alerts** rather
than **Banners** in OpenMergeLens's macOS notification settings to keep the
alert visible on screen until you close it. An active Focus can still delay an
alert; add OpenMergeLens to that Focus mode's **Allowed Apps** or temporarily
turn Focus off when testing delivery.

macOS 12 and earlier retain the smaller legacy `terminal-notifier` helper. Both
helpers support Intel and Apple Silicon without relying on background
AppleScript or Rosetta. Windows uses PowerShell toasts registered under
OpenMergeLens and sends them as reminder notifications, so they stay visible
until dismissed manually when Windows notification settings allow them. Linux
uses `notify-send` with critical urgency to request alerts that stay visible
until the user dismisses them. A logged-in graphical desktop session is
required; headless and logged-out scheduler sessions cannot display a toast. On
Linux, scheduled polls reuse the setup-time notification session variables when
they are available, and skip notification delivery without logging a warning
when no graphical notification session is available. Linux systems must provide
`notify-send`.

Set `"desktopNotifications": false` in the config to opt out. For temporary or
headless execution, `OPENMERGELENS_DESKTOP_NOTIFICATIONS=0` also suppresses
notifications, including fatal startup notifications that happen before the
config can be loaded.

When notifications are enabled during `openmergelens init`, or changed from
disabled to enabled in `openmergelens config`, the command sends a test
notification after saving the configuration and asks whether it appeared. If delivery fails
or the operating system accepts the notification without displaying it, the
wizard prints the relevant notification-settings steps. Operating-system
permission still requires user confirmation and cannot be enabled silently.

## Scheduling

If you chose **I'll run it myself** during `init`, or just want to run one
poll manually, use the one-shot command directly:

```
openmergelens
```

Use `openmergelens --dry-run` to exercise a poll without posting a review.

For an OS-level schedule, run `openmergelens config`, choose **Schedule**, and
select cron, launchd, or Task Scheduler. The snippets below are the commands generated for an installed schedule; they require the `~/.openmergelens/scheduler-environment.json` file
created by `init`/the installer. `config` creates the same file when a schedule
is edited. Do not use these scheduled-runner snippets as
the manual one-shot command:

- **cron** (macOS/Linux, installed schedule):
  ```
  */15 * * * * '/usr/bin/node' '/absolute/path/to/openmergelens/bin/scheduled.mjs' '/Users/you/.openmergelens/scheduler-environment.json' >> '/Users/you/.openmergelens/poll.log' 2>&1 # openmergelens:managed:cron:v1
  ```
  The application logger is the primary log writer; the redirection preserves
  unexpected wrapper/startup output. Cron supports only exact hourly cadences:
  1, 2, 3, 4, 5, 6, 10, 12, 15,
  20, or 30 minutes. These are the positive whole-minute intervals that divide
  an hour; cron step expressions reset at each hour, so values such as 7 or 59
  would create a shorter gap at the boundary and are rejected. launchd and
  Windows Task Scheduler accept positive whole-minute intervals from 1 through
  1439; this shared maximum matches Windows Task Scheduler's `/mo` minute
  limit.
- **launchd** (macOS, installed schedule): the wizard writes a plist to
  `~/Library/LaunchAgents/io.github.suguspnk.openmergelens.poll.plist` and loads it with
  `launchctl load`.
- **Windows Task Scheduler (installed schedule)**: the wizard writes a private
  `scheduler-task.xml` beside the environment file, then runs
  `schtasks /create /f /tn openmergelens-poll /xml ".../scheduler-task.xml"`.
  The XML keeps the minute trigger separate from the `<Exec>` command and
  arguments, so long install paths do not hit `schtasks`' `/tr` limit. The
  `wscript.exe` launcher keeps scheduled Windows polls hidden instead of
  flashing a console window while Node runs.

The wizard only offers schedulers supported by the current operating system.
Installed schedules use an environment file under `~/.openmergelens/` to retain
the `PATH` validated during setup, the user home and reviewer config directory
used by Codex or Claude, any supported POSIX `OPENMERGELENS_HOME` override, and the Linux
desktop notification session variables needed by `notify-send` when they are
present. This keeps `gh`, the selected reviewer CLI, and desktop
notifications discoverable under the restricted environments used by cron,
launchd, and Task Scheduler. The file contains paths and local session
addresses only, never GitHub or reviewer credentials.

## Privacy, security, and cost

OpenMergeLens has no server, account system, analytics, or telemetry. It stores
configuration, review state, logs, prompts, and learnings locally. GitHub data
is retrieved through your authenticated `gh` installation. GitHub credentials
are never written to OpenMergeLens config and are not passed to the reviewer;
the reviewer receives a temporary read-only tool scoped to one repository and
pull request.

Pull-request content is untrusted input. OpenMergeLens validates tool requests,
uses shell-free process arguments, bounds subprocess output, rechecks the head
commit before posting, and sanitizes diagnostics. A custom reviewer remains
trusted local software and is governed by its provider's privacy, billing, and
usage terms.

Repository selection and AI-processing consent are separate controls. Setup
requires one confirmation covering the complete selected repository set,
stating that each repository owner permits the selected provider to process
source code, PR content, and personal data under acceptable retention,
training, confidentiality, data-residency, and DPA terms. A missing or false
top-level `aiProcessingConsent` is cryptographically scoped to the reviewer,
accounts, and repositories; a missing, malformed, or mismatched authorization
prevents searches and reviewer invocation for every repository. Version 2
configurations migrate to consented only when every selected repository
already had explicit consent; partial or missing legacy consent fails closed
until `openmergelens init` or `openmergelens config` records the bulk
authorization.

The default four focused review passes plus synthesis make five reviewer
invocations per PR. Lower `reviewFocusCount` to reduce usage. GitHub and
reviewer rate limits can still delay or fail work; failures leave review state
untouched so a later poll retries. Review POSTs are globally serialized with
at least one second between mutations. A GitHub `Retry-After` or rate-reset
signal pauses later review posts; otherwise a detected rate-limit response
backs off for at least one minute.

See the
[security policy](https://github.com/suguspnk/openmergelens/blob/main/SECURITY.md)
for the security model and private reporting process.

## Known limitations

- The host machine must be awake, online, and able to run `gh` and the reviewer
  when the schedule fires.
- Only explicitly selected repositories are searched.
- OpenMergeLens does not create or renew GitHub reviewer requests. A new PR must
  have a manual request or a matching `CODEOWNERS` request, and a PR that was
  already reviewed needs a fresh request after new commits before it is reviewed
  again.
- The 365-day review-state retention limit bounds local storage. An unchanged,
  still-requested PR can become eligible again after its record expires if its
  prior review marker cannot be reconciled, so very old requests may be
  re-reviewed.
- Notifications require a logged-in graphical session; Linux also requires
  `notify-send`. Notification activation on Linux depends on the desktop
  notification server supporting actions; use `openmergelens report` as the
  fallback.
- Reviewer quality, latency, context limits, and cost depend on the configured
  reviewer.
- OpenMergeLens supports maintained Node.js 22 and 24 releases. EOL Node.js
  versions are not supported.

## Customizing reviews

- **`~/.openmergelens/docs/review-prompts/<host>/<owner>/<repo>.md`**: the
  prompt shared by every configured reviewer of that host/repository. It defines
  the framing, review criteria, and where the PR URL and past learnings get inserted (via
  `{{pr_url}}`, `{{pr_number}}`, and `{{learnings_section}}` placeholders).
  Existing templates using `{{diff}}` remain compatible: that placeholder now
  expands as part of fixed prompt instructions directing the reviewer to inspect
  the linked PR with the constrained `openmergelens.inspect_github_pr` MCP tool.
  The diff itself is fetched host-side for deterministic inline-anchor validation,
  not embedded in the reviewer prompt or inspected directly with `gh`.
  `{{pr_title}}` and `{{pr_body}}` are retained for compatibility but direct the
  agent to retrieve current metadata.
  `init` or `config` seeds one copy per
  watched repo from the bundled default the first time you add that repo;
  edit a repo's copy directly any time: reorder sections, change the
  criteria, and adjust the framing without a code change or wizard rerun. It
  never affects any other repo's prompt. Re-running `init` never
  overwrites an existing copy. The strict JSON output-format instruction
  the review-posting logic depends on to anchor inline comments is always
  appended automatically and isn't part of this file, so an edit here can't
  break that regardless of what you change.
- **`~/.openmergelens/docs/learnings/<host>/<username>/<owner>/<repo>.md`**:
  corrections isolated to one reviewer identity and repository (for example,
  "don't flag X, it's intentional because Y"). `init` or `config` creates each
  selected target's file and never overwrites its contents.

## Troubleshooting

- **`gh` not authenticated**: `gh auth login`, then rerun.
- **Configured GitHub account is unavailable**: authenticate it with
  `gh auth login --hostname <hostname>`, or rerun `openmergelens init` or
  `openmergelens config` and select another
  account. Polling does not depend on whichever account is globally active.
- **Reviewer CLI "found but not authenticated"** during `init` or `config`: run the
  login command it prints (e.g. `claude /login`), then continue.
- **Codex reports "Not inside a trusted directory"**: current versions
  automatically upgrade known older generated Codex commands to the current
  ephemeral, strict, read-only command. Upgrade OpenMergeLens or rerun
  `openmergelens init`; custom Codex commands are intentionally not rewritten.
- **Nothing happens on a poll run**: first confirm that the selected account is
  in the PR's **Reviewers** list. For a re-review, the PR author must request it
  again after new commits. Then check `~/.openmergelens/poll.log` for the
  specific failure (search failed, reviewer adapter failed, post rejected, etc.).
- **Reviews work but notifications do not**: make sure the poll runs while
  you are logged into a graphical desktop session. Run `openmergelens config`,
  enable notifications, and confirm the test notification to get
  platform-specific recovery steps. On
  Linux, install `notify-send`; then check `~/.openmergelens/poll.log` for a
  `[notification]` warning.
- **A notification does not open its report**: run `openmergelens report` to
  open the latest retained snapshot or `openmergelens report --list` to choose
  one. On Linux, the desktop notification server may not support actions even
  when `notify-send` is installed.
- **A review didn't fully post**: OpenMergeLens validates finding line numbers
  against the actual diff before posting; anything it can't anchor to a real
  line gets folded into the review's summary text instead of being dropped
  silently, so check the summary for an "Additional findings" section.

## Uninstall

Remove the scheduler before uninstalling the package:

- **cron:** run `crontab -e` and remove the line ending in
  `# openmergelens:managed:cron:v1`.
- **launchd:** run
  `launchctl unload ~/Library/LaunchAgents/io.github.suguspnk.openmergelens.poll.plist`,
  then delete that plist.
- **Windows Task Scheduler:** run
  `schtasks /delete /f /tn openmergelens-poll`.

Then run `npm uninstall -g openmergelens`. Your local state is intentionally
preserved. Delete `~/.openmergelens` only if you also want to permanently
remove config, review history, logs, prompts, and learnings.

## Community and releases

See the
[contribution guide](https://github.com/suguspnk/openmergelens/blob/main/CONTRIBUTING.md),
[support policy](https://github.com/suguspnk/openmergelens/blob/main/SUPPORT.md),
[code of conduct](https://github.com/suguspnk/openmergelens/blob/main/CODE_OF_CONDUCT.md),
and [changelog](./CHANGELOG.md). Maintainer release steps are documented in
[docs/RELEASING.md](https://github.com/suguspnk/openmergelens/blob/main/docs/RELEASING.md).

## License

[MIT](./LICENSE)

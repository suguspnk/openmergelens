import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../lib/config.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readText(filePath) {
  return (await readFile(filePath, 'utf8')).replace(/\r\n?/gu, '\n');
}

test('PRD config shape remains valid for the current validator', async () => {
  const prd = await readText(path.join(projectRoot, 'PRD.md'));
  const match = prd.match(/## Config shape\s*```json\s*([\s\S]*?)\s*```/u);
  assert.ok(match, 'PRD must include a JSON config-shape example');

  const example = JSON.parse(match[1]);
  const config = validateConfig(example);
  assert.equal(config.configVersion, 5);
  assert.equal(config.reviewerInputMode, 'stdin');
  assert.match(config.reviewerCommand, /\{\{mcp_config\}\}/u);
  assert.match(config.reviewerCommand, /\{\{mcp_tool\}\}/u);
  assert.doesNotMatch(prd, /\{prompt_file\}/u);
  assert.doesNotMatch(prd, /Config version 2 is a clean break/u);
  assert.match(prd, /Version 2 repository-scoped consent and version 3 and 4 configs are migrated/u);
  assert.match(prd, /Codex CLI.*codex login status/su);
  assert.doesNotMatch(prd, /codex exec --skip-git-repo-check\s+--ephemeral\s+--sandbox read-only "ok"/u);
  assert.match(prd, /matching `CODEOWNERS` rule/u);
  assert.match(prd, /new commits alone are not a trigger/u);
  assert.match(prd, /State is keyed by reviewer account \+ PR \+ last-reviewed/u);
  assert.match(prd, /request that account again in GitHub's\s+\*\*Reviewers\*\*/u);
  assert.match(prd, /Validated search results are the only source of\s+review candidates/u);
  assert.match(prd, /stable pagination metadata plus\s+distinct candidate and page counts/u);
  assert.match(prd, /incomplete or capped results,[\s\S]*?fail\s+the complete account\/repository scope closed/u);
  assert.match(prd, /absent from a page are never authoritative evidence for deleting review state\s+or scheduling cursors/u);
  assert.match(prd, /Revalidate that the\s+exact configured user login is still in GitHub's requested-reviewer list/u);
  assert.match(prd, /Immediately\s+before every POST, including the HTTP 422 summary-only fallback/u);
  assert.match(prd, /Read-only reconciliation is not a POST mutation and remains permitted/u);
  assert.doesNotMatch(prd, /tracked(?:-state)? fallback/iu);
});

test('PRD documents bounded compatible review-state retention', async () => {
  const prd = await readText(path.join(projectRoot, 'PRD.md'));

  assert.match(prd, /Review records expire locally after exactly 365 days/u);
  assert.match(prd, /at most 25\s+remote operations between exact marker proof and direct closure checks/u);
  assert.match(prd, /selected,\s+authenticated,\s+configured\s+account\/repository scopes/u);
  assert.match(prd, /search absence, lookup failure,\s+malformed metadata, HTTP 404, and `OPEN` all retain state/u);
  assert.match(prd, /`reviewStateGcAfterKey` cursor/u);
  assert.match(prd, /Metadata remains version 1 for additive compatibility/u);
  assert.match(prd, /16 MiB pre-parse bound and can contain at most 10,000/u);
  assert.match(prd, /reserve the candidate's\s+exact final key, SHA, timestamp, entry count, and bytes before marker\s+reconciliation, diff fetch, prompt reads, or AI/u);
  assert.match(prd, /equal soft entry and byte shares and can borrow unused\s+global space/u);
  assert.match(prd, /never evicts the current key, an active reservation, unscoped\/invalid state, or\s+a record without exact marker proof/u);
  assert.match(prd, /reviewMarkerVersion: 1/u);
  assert.match(prd, /still-requested PR can become\s+eligible\s+again after expiry/u);
});

test('project instructions describe the requested-review re-review trigger', async () => {
  const agents = await readText(path.join(projectRoot, 'AGENTS.md'));
  assert.match(agents, /per-account PR last-reviewed SHA/u);
  assert.match(agents, /HOST@USERNAME::OWNER\/REPO#N/u);
  assert.match(agents, /requested\s+again\s+in\s+GitHub's\s+\*\*Reviewers\*\*\s+list/u);
  assert.match(agents, /new commits alone are not a trigger/u);
});

test('PRD notification contract documents deferred outcomes as non-attention', async () => {
  const prd = await readText(path.join(projectRoot, 'PRD.md'));
  const match = prd.match(/9\. \*\*Notify after the complete poll settles\.\*[\s\S]*?(?=\n\n10\.)/u);
  assert.ok(match, 'PRD must include the notification contract');
  assert.match(
    match[0],
    /deferred\s+outcomes\s+\(informational\s+and\s+not\s+requiring\s+attention\)/u,
  );
});

test('PRD documents the current reviewer and GitHub review contracts', async () => {
  const prd = await readText(path.join(projectRoot, 'PRD.md'));

  assert.doesNotMatch(prd, /gh pr comment/u);
  assert.doesNotMatch(prd, /prompt \+ diff/u);
  assert.match(prd, /formal GitHub PR review.*inline comments/su);
  assert.match(prd, /REST.*reviews endpoint.*\/pulls\/<N>\/reviews/su);
  assert.match(prd, /prompt-only.*stdin.*constrained MCP.*structured review JSON/su);
  assert.match(prd, /diff.*never embedded in reviewer input/su);
});

test('PRD keeps synthesis on the constrained MCP inspection path', async () => {
  const prd = await readText(path.join(projectRoot, 'PRD.md'));
  const pipeline = prd.match(
    /5\. \*\*Run independent reviewer passes\*\*[\s\S]*?(?=\n\n6\.)/u,
  );
  assert.ok(pipeline, 'PRD must include the reviewer pipeline contract');

  const synthesis = pipeline[0].match(
    /A final synthesis invocation[\s\S]*?result to post\./u,
  );
  assert.ok(synthesis, 'PRD must describe the final synthesis invocation');
  assert.match(synthesis[0], /same constrained MCP inspection\s+tool\/gateway/u);
  assert.match(
    synthesis[0],
    /receives all candidate findings[\s\S]*?reconciles those candidates[\s\S]*?merges duplicate root causes[\s\S]*?discards unsupported claims/u,
  );
  assert.doesNotMatch(synthesis[0], /\bgh\b/u);
});

test('PRD scheduling contract documents the generated scheduled runner', async () => {
  const prd = await readText(path.join(projectRoot, 'PRD.md'));
  const match = prd.match(/## Scheduling\s*([\s\S]*?)(?=\n## Auth prerequisites)/u);
  assert.ok(match, 'PRD must include the scheduling contract');
  const scheduling = match[1];

  assert.match(scheduling, /bin\/scheduled\.mjs/u);
  assert.match(scheduling, /scheduler-environment\.json/u);
  assert.match(scheduling, /bin\/scheduled-win32\.vbs/u);
  assert.match(scheduling, /node bin\/poll\.mjs` remains a one-shot/u);
  assert.match(scheduling, /node bin\/poll\.mjs --dry-run/u);
  assert.doesNotMatch(scheduling, /cron` entry[^\n]*running `node bin\/poll\.mjs`/u);
  assert.doesNotMatch(scheduling, /Windows Task Scheduler entry running `node bin\/poll\.mjs`/u);
});

test('PRD documents cadence-safe cron intervals separately from host schedulers', async () => {
  const prd = await readText(path.join(projectRoot, 'PRD.md'));
  const scheduling = prd.match(/## Scheduling\s*([\s\S]*?)(?=\n## Auth prerequisites)/u)?.[1];

  assert.ok(scheduling, 'PRD must include the scheduling contract');
  assert.match(
    scheduling,
    /Supported\s+intervals\s+are\s+1,\s+2,\s+3,\s+4,\s+5,\s+6,\s+10,\s+12,\s+15,\s+20,\s+and\s+30\s+minutes/u,
  );
  assert.match(scheduling, /values such as 7 or 59 are rejected/u);
  assert.match(
    scheduling,
    /launchd and Task Scheduler accept positive whole-minute intervals from 1\s+through 1439[\s\S]*?this shared maximum matches Task Scheduler's `\/mo` minute\s+limit/u,
  );
});

test('PRD requires a persistent published install before configuring schedules', async () => {
  const prd = await readText(path.join(projectRoot, 'PRD.md'));
  const onboarding = prd.match(/## Onboarding \(`openmergelens init`\)[\s\S]*?(?=\n## Decisions)/u);
  const scheduling = prd.match(/## Scheduling\s*([\s\S]*?)(?=\n## Auth prerequisites)/u);

  assert.ok(onboarding, 'PRD must include the onboarding contract');
  assert.ok(scheduling, 'PRD must include the scheduling contract');
  assert.match(onboarding[0], /npm install -g openmergelens[\s\S]*?openmergelens init/u);
  assert.match(onboarding[0], /pnpm add --global openmergelens/u);
  assert.doesNotMatch(onboarding[0], /pnpm dlx openmergelens init/u);
  assert.match(
    onboarding[0],
    /Temporary `npx` and `pnpm dlx` runners are for manual, one-shot[\s\S]*?do not use them to configure an installed OS schedule/u,
  );
  assert.match(
    scheduling[1],
    /Before configuring an installed OS schedule[\s\S]*?install OpenMergeLens persistently[\s\S]*?npm install -g openmergelens/u,
  );
  assert.match(scheduling[1], /temporary `npx` or `pnpm dlx` runners/u);
  assert.match(scheduling[1], /Use `npx`\s+or\s+`pnpm dlx` only for manual, one-shot commands/u);
  assert.match(onboarding[0], /node bin\/init\.mjs` as usual/u);
});

test('PRD documents user-home state storage rather than repository-root state', async () => {
  const prd = await readText(path.join(projectRoot, 'PRD.md'));
  const configExample = JSON.parse(
    await readText(path.join(projectRoot, 'config.example.json')),
  );
  const architecture = prd.match(/## Architecture\s*```[\s\S]*?```/u);
  const runtimeState = prd.match(/## Per-user runtime state\s*([\s\S]*?)(?=\n## )/u);

  assert.ok(architecture, 'PRD must include the architecture tree');
  assert.ok(runtimeState, 'PRD must include the per-user runtime state contract');
  assert.doesNotMatch(architecture[0], /├── state\.json/u);
  assert.doesNotMatch(architecture[0], /state\.json\s*\(gitignored/u);
  assert.match(runtimeState[1], /All per-user runtime state lives outside this repository/u);
  assert.match(runtimeState[1], /`~\/\.openmergelens\/` by default/u);
  assert.match(runtimeState[1], /`OPENMERGELENS_HOME` environment variable/u);
  assert.match(
    runtimeState[1],
    /config\.json.*state\.json.*poll\.log.*reports.*review-prompts.*learnings.*scheduler-environment\.json/su,
  );
  assert.match(prd, /`stateFile` supports an explicit absolute path/u);
  assert.match(prd, /Relative values are resolved\s+under the user home/su);
  assert.equal(configExample.stateFile, './state.json');
});

test('PRD discovery command matches the explicit paginated GitHub search contract', async () => {
  const [prd, github] = await Promise.all([
    readText(path.join(projectRoot, 'PRD.md')),
    readText(path.join(projectRoot, 'lib/github.mjs')),
  ]);
  const discovery = prd.match(
    /1\. \*\*Discover candidate PRs\.\*[\s\S]*?```bash\s*([\s\S]*?)\s*```/u,
  );
  const searchImplementation = github.match(
    /export async function searchReviewRequestedPRs\([\s\S]*?(?=\nexport async function hasActiveReviewRequest\()/u,
  );

  assert.ok(discovery, 'PRD must include the discovery command');
  assert.ok(searchImplementation, 'GitHub search implementation must remain discoverable');
  const command = discovery[1];
  const implementation = searchImplementation[0];

  assert.match(command, /gh api --paginate --method GET \/search\/issues/u);
  assert.match(command, /review-requested:USERNAME repo:OWNER\/REPO/u);
  assert.match(command, /-f per_page=100/u);
  assert.match(
    command,
    /--jq '"meta\|" \+ \(\.total_count \| tostring\) \+ "\|" \+ \(\.incomplete_results \| tostring\), \(\.items\[\] \| \.repository_url \+ "\|" \+ \(\.number \| tostring\)\)'/u,
  );
  assert.doesNotMatch(command, /review-requested:antonio/u);
  assert.match(prd, /Global search is intentionally unsupported: coverage must be explicit/u);
  assert.match(prd, /Resolve each account with `gh auth token --hostname \.\.\. --user \.\.\.`/u);
  assert.match(prd, /scope every child command with that credential/u);

  assert.match(implementation, /'api', '--paginate', '--method', 'GET', '\/search\/issues'/u);
  assert.match(implementation, /review-requested:\$\{normalizedUsername\} repo:\$\{normalizedRepo\}/u);
  assert.match(implementation, /'-f', `per_page=\$\{GITHUB_SEARCH_PAGE_SIZE\}`/u);
  assert.match(
    implementation,
    /'--jq',[\s\S]*?\.total_count[\s\S]*?\.incomplete_results[\s\S]*?\.items\[\][\s\S]*?\.repository_url/u,
  );
  assert.doesNotMatch(implementation, /\/pulls/u);
  assert.match(implementation, /did not provide a complete result set/u);
  assert.match(implementation, /candidate count did not match result metadata/u);
  assert.match(implementation, /inconsistent pagination metadata/u);
});

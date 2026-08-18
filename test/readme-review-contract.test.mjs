import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('README requires a fresh active request for every review candidate', async () => {
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');

  assert.match(readme, /pushing another commit does not start a\s+re-review by itself/u);
  assert.match(readme, /Locally tracked PRs are never added to the queue on their own/u);
  assert.match(readme, /Search pagination\s+metadata and the distinct candidate count must agree/u);
  assert.match(readme, /malformed\s+or foreign row fail the whole repository scope closed/u);
  assert.match(readme, /Historical state and scheduling cursors are retained when a PR is\s+absent from Search/u);
  assert.match(readme, /A requested PR that is fetched and found closed or merged is retired/u);
  assert.match(readme, /Dry runs never change\s+state/u);
  assert.match(readme, /revalidates the exact, case-insensitive requested-reviewer\s+login after generation and immediately before every review POST/u);
  assert.match(readme, /Read-only reconciliation after an ambiguous or\s+successful\s+POST\s+remains allowed/u);
  assert.match(readme, /bounded unrelated `Bot` actors ending in `\[bot\]` may coexist/u);
  assert.match(readme, /Review records expire 365 days/u);
  assert.match(readme, /at most\s+25 deterministic, rotating historical-maintenance operations/u);
  assert.match(readme, /state file is limited to\s+10,000 review records and 16 MiB/u);
  assert.match(readme, /reserves the candidate's\s+exact key, SHA, canonical timestamp, record count, and serialized UTF-8 bytes\s+before marker reconciliation, diff fetch, prompt reads, or reviewer work/u);
  assert.match(readme, /equal soft entry and byte shares but may borrow unused global capacity/u);
  assert.match(readme, /Current, reserved, unscoped, malformed, and\s+unproven records are never evicted/u);
  assert.match(readme, /still-requested PR can become eligible again after its record expires/u);
  assert.doesNotMatch(readme, /tracked fallback/iu);
});

test('README documents the constrained MCP contract for {{diff}}', async () => {
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
  const customizingReviews = readme.match(
    /## Customizing reviews[\s\S]*?(?=\n## )/u,
  )?.[0];

  assert.ok(customizingReviews, 'README must include the Customizing reviews section');
  assert.match(
    customizingReviews,
    /\{\{diff\}\}[\s\S]*?fixed prompt instructions[\s\S]*?`openmergelens\.inspect_github_pr` MCP tool/u,
  );
  assert.match(
    customizingReviews,
    /diff itself is fetched host-side for deterministic inline-anchor validation/u,
  );
  assert.match(
    customizingReviews,
    /not embedded in the reviewer prompt or inspected directly with `gh`/u,
  );
  assert.doesNotMatch(
    customizingReviews,
    /\{\{diff\}\}[\s\S]*?inspecting the linked PR with `gh`/u,
  );
});

test('README documents the MCP-only reviewer inspection path in dry-run mode', async () => {
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
  const dryRun = readme.match(
    /## Try it \(dry run\)[\s\S]*?(?=\n## )/u,
  )?.[0];

  assert.ok(dryRun, 'README must include the dry-run section');
  assert.match(
    dryRun,
    /Host-side operations use `gh` for PR search, authentication, and\s+metadata\/diff fetch/u,
  );
  assert.match(
    dryRun,
    /each reviewer pass inspects the linked PR through the\s+constrained\s+`openmergelens\.inspect_github_pr` MCP tool/u,
  );
  assert.doesNotMatch(
    dryRun,
    /(?:\b(?:every|each|all)\s+)?\b(?:reviewer\s+)?passes?\s+(?:directly\s+)?uses?\s+`gh`\s+(?:to\s+)?inspect/iu,
  );
});

test('README uses the installed executable for manual polling', async () => {
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
  const scheduling = readme.match(
    /## Scheduling[\s\S]*?(?=\n## )/u,
  )?.[0];

  assert.ok(scheduling, 'README must include the Scheduling section');
  const manual = scheduling.match(
    /If you chose \*\*I'll run it myself\*\*[\s\S]*?(?=\nFor an OS-level schedule)/u,
  )?.[0];

  assert.ok(manual, 'README must include the manual one-shot instructions');
  assert.match(
    manual,
    /```\s*openmergelens\s*```/u,
  );
  assert.match(manual, /`openmergelens --dry-run`/u);
  assert.doesNotMatch(manual, /\bnode\s+bin\/poll\.mjs(?:\s+--dry-run)?\b/u);
  assert.match(
    scheduling,
    /snippets below are the commands generated for an installed\s+schedule;[\s\S]*?require the `~\/\.openmergelens\/scheduler-environment\.json` file\s+created by `init`\/the installer/u,
  );
  assert.match(scheduling, /scheduled\.mjs/u);
  assert.doesNotMatch(
    scheduling,
    /If you skipped scheduling[\s\S]*?bin\/scheduled\.mjs/u,
  );
});

test('README documents cadence-safe cron intervals separately from host schedulers', async () => {
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
  const scheduling = readme.match(/## Scheduling[\s\S]*?(?=\n## )/u)?.[0];

  assert.ok(scheduling, 'README must include the Scheduling section');
  assert.match(
    scheduling,
    /Cron supports only exact hourly cadences:\s+1,\s+2,\s+3,\s+4,\s+5,\s+6,\s+10,\s+12,\s+15,\s+20,\s+or\s+30\s+minutes/u,
  );
  assert.match(scheduling, /values such as 7 or 59[\s\S]*?are rejected/u);
  assert.match(
    scheduling,
    /launchd and\s+Windows Task Scheduler accept positive whole-minute intervals from 1 through\s+1439[\s\S]*?this shared maximum matches Windows Task Scheduler's `\/mo` minute\s+limit/u,
  );
});

test('README pairs each global package manager with its package root command', async () => {
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
  const install = readme.match(/## Install[\s\S]*?(?=\n## )/u)?.[0];
  const manualSetup = readme.match(
    /### Setting up by hand instead[\s\S]*?(?=\n\| `configVersion`)/u,
  )?.[0];

  assert.ok(install, 'README must include the install instructions');
  assert.ok(manualSetup, 'README must include the manual setup instructions');
  assert.match(install, /npm install -g openmergelens/u);
  assert.match(install, /pnpm add --global openmergelens/u);
  assert.match(manualSetup, /npm global install[\s\S]*?npm root -g/u);
  assert.match(manualSetup, /pnpm global install[\s\S]*?pnpm root -g/u);
  assert.match(
    manualSetup,
    /`<that path>\/openmergelens\/config\.example\.json`/u,
  );
  assert.doesNotMatch(manualSetup, /\bnode\s+bin\//u);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

async function readProjectFile(relativePath) {
  const contents = await readFile(path.join(projectRoot, relativePath), 'utf8');
  return contents.replaceAll('\r\n', '\n');
}

test('release metadata is finalized as 1.5.1', async () => {
  const packageJson = JSON.parse(await readProjectFile('package.json'));
  const changelog = await readProjectFile('CHANGELOG.md');

  assert.equal(packageJson.version, '1.5.1');
  assert.match(changelog, /^## \[1\.5\.1] - \d{4}-\d{2}-\d{2}$/m);
  assert.match(changelog, /^## \[1\.5\.0] - \d{4}-\d{2}-\d{2}$/m);
  assert.match(changelog, /^## \[1\.4\.0] - \d{4}-\d{2}-\d{2}$/m);
  assert.match(changelog, /^## \[1\.3\.0] - \d{4}-\d{2}-\d{2}$/m);
  assert.match(changelog, /^## \[1\.2\.0] - \d{4}-\d{2}-\d{2}$/m);
  assert.match(changelog, /^## \[1\.0\.0] - \d{4}-\d{2}-\d{2}$/m);
  assert.doesNotMatch(changelog, /\[0\.1\.0-beta\.0]/);
});

test('trusted publishing is manually dispatched with an exact release tag', async () => {
  const workflow = await readProjectFile('.github/workflows/publish.yml');

  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  release:/m);
  assert.match(workflow, /ref: \$\{\{ inputs\.release_tag }}/);
  assert.match(workflow, /release_sha: \$\{\{ steps\.release\.outputs\.sha }}/);
  assert.match(workflow, /ref: \$\{\{ needs\.verify\.outputs\.release_sha }}/);
  assert.match(workflow, /refs\/tags\/\$\{RELEASE_TAG}\^\{commit}/);
  assert.match(workflow, /test "\$tag_commit" = "\$VERIFIED_SHA"/);
  assert.match(workflow, /npm stage publish .*--tag/);
});

test('OIDC is isolated to the script-free staging job', async () => {
  const workflow = await readProjectFile('.github/workflows/publish.yml');
  const verifyJob = workflow.slice(
    workflow.indexOf('  verify:'),
    workflow.indexOf('  stage:'),
  );
  const stageJob = workflow.slice(workflow.indexOf('  stage:'));

  assert.doesNotMatch(verifyJob, /id-token:\s*write/);
  assert.match(verifyJob, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(stageJob, /needs: verify/);
  assert.match(stageJob, /permissions:\n\s+contents: read\n\s+id-token: write/);
  assert.doesNotMatch(stageJob, /pnpm install|pnpm release:check/);
  assert.match(stageJob, /npm stage publish --ignore-scripts --tag/);
});

test('FINDING-PKG-001 staging pins the npm CLI required by npm stage', async () => {
  const workflow = await readProjectFile('.github/workflows/publish.yml');
  const stageJob = workflow.slice(workflow.indexOf('  stage:'));

  assert.match(
    stageJob,
    /npm install --global npm@11\.15\.0\n\s+test "\$\(npm --version\)" = "11\.15\.0"/,
  );
  assert.match(stageJob, /npm stage publish --ignore-scripts --tag/);
});

test('bootstrap documentation prevents restaging immutable version 1.0.0', async () => {
  const releasing = await readProjectFile('docs/RELEASING.md');

  assert.match(releasing, /npm publish --tag latest/);
  assert.match(releasing, /Do not dispatch\s+`publish\.yml`/);
  assert.match(
    releasing,
    /gh workflow run publish\.yml -f release_tag=v<version>/,
  );
});

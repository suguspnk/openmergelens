import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureReviewPrompt,
  reviewPromptPathFor,
} from '../lib/review-prompts.mjs';
import { createTestHome, setProcessTestHome } from './test-home.mjs';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

async function withHome(t) {
  const home = await createTestHome(t, 'openmergelens-prompts-');
  setProcessTestHome(t, home);
  return home;
}

test('prompt paths are shared by repository on one host and isolated across hosts', async (t) => {
  const home = await withHome(t);
  assert.equal(
    reviewPromptPathFor('GitHub.com', 'Owner/Repo'),
    path.join(home, 'docs', 'review-prompts', 'github.com', 'owner', 'repo.md'),
  );
  assert.notEqual(
    reviewPromptPathFor('github.com', 'owner/repo'),
    reviewPromptPathFor('enterprise.example.com', 'owner/repo'),
  );
});

test('Bitbucket prompt paths accept a valid Cloud workspace longer than a GitHub owner', async (t) => {
  const home = await withHome(t);
  const workspace = 'a'.repeat(62);

  assert.equal(
    reviewPromptPathFor('bitbucket.org', `${workspace}/repo`),
    path.join(home, 'docs', 'review-prompts', 'bitbucket.org', workspace, 'repo.md'),
  );
});

test('ensureReviewPrompt seeds once and never overwrites custom content', async (t) => {
  await withHome(t);
  const templatePath = path.join(process.env.OPENMERGELENS_HOME, 'template.md');
  await writeFile(templatePath, 'template\n');

  const destination = await ensureReviewPrompt('github.com', 'owner/repo', {
    templatePath,
  });
  assert.equal(await readFile(destination, 'utf8'), 'template\n');

  await writeFile(destination, 'custom\n');
  await ensureReviewPrompt('github.com', 'owner/repo', { templatePath });
  assert.equal(await readFile(destination, 'utf8'), 'custom\n');
});

test('dry-run prompt lookup does not create or harden local files', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = await withHome(t);
  const templatePath = path.join(home, 'template.md');
  const destinationPath = reviewPromptPathFor('github.com', 'owner/repo');
  await writeFile(templatePath, 'bundled template\n');

  const fallback = await ensureReviewPrompt('github.com', 'owner/repo', {
    templatePath,
    dryRun: true,
  });
  assert.equal(fallback, templatePath);
  await assert.rejects(readFile(destinationPath, 'utf8'), { code: 'ENOENT' });

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, 'custom prompt\n');
  await chmod(destinationPath, 0o644);
  const existing = await ensureReviewPrompt('github.com', 'owner/repo', {
    templatePath,
    dryRun: true,
  });
  assert.equal(existing, destinationPath);
  assert.equal(await readFile(destinationPath, 'utf8'), 'custom prompt\n');
  assert.equal((await stat(destinationPath)).mode & 0o777, 0o644);
});

test('real prompt initialization keeps files private', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = await withHome(t);
  const templatePath = path.join(home, 'template.md');
  await writeFile(templatePath, 'template\n');

  const destination = await ensureReviewPrompt('github.com', 'owner/repo', {
    templatePath,
  });
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  await chmod(destination, 0o644);
  await ensureReviewPrompt('github.com', 'owner/repo', { templatePath });
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
});

test('two accounts on the same host use the same prompt path', async (t) => {
  await withHome(t);
  const first = reviewPromptPathFor('github.com', 'owner/repo');
  const second = reviewPromptPathFor('github.com', 'OWNER/REPO');
  assert.equal(first, second);
});

test('the bundled prompt is self-contained after it is copied to user state', async () => {
  const prompt = await readFile(
    path.join(projectRoot, 'docs', 'review-prompt.default.md'),
    'utf8',
  );
  const relativeLinks = [...prompt.matchAll(/\[[^\]]*]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|#)/i.test(target));

  assert.deepEqual(
    relativeLinks,
    [],
    'a seeded prompt cannot rely on files from the package or source checkout',
  );
});

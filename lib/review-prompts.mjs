import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { userPath } from './paths.mjs';
import {
  normalizeBitbucketRepository,
  normalizeGitHubAccount,
  normalizeRepository,
} from './config.mjs';
import {
  enforcePrivateMode,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';

// One review prompt per watched repo (not one shared file) so customizing
// what OpenMergeLens looks for in one repo never silently changes what it
// looks for in another. Lives under the user's OpenMergeLens home (see
// lib/paths.mjs), not the package install dir, alongside config.json/
// state.json/the bundled-default's editable copy.
export function reviewPromptPathFor(hostname, repo) {
  const account = normalizeGitHubAccount({ hostname, username: 'path-user' });
  const normalizedRepo = (account.hostname === 'bitbucket.org'
    ? normalizeBitbucketRepository(repo)
    : normalizeRepository(repo)
  ).toLowerCase();
  const [owner, name] = normalizedRepo.split('/');
  return userPath(
    'docs',
    'review-prompts',
    account.hostname,
    owner,
    `${name}.md`,
  );
}

// Seeds a per-host/repo review prompt on first use only; never overwrites an
// existing copy, so re-running init can't clobber an edited prompt. Accounts
// on the same host share this file; each account's learnings remain separate.
export async function ensureReviewPrompt(
  hostname,
  repo,
  {
    templatePath,
    destinationPath = reviewPromptPathFor(hostname, repo),
    dryRun = false,
  },
) {
  const absolutePath = destinationPath;

  try {
    await readFile(absolutePath, 'utf8');
    if (!dryRun) await enforcePrivateMode(absolutePath, PRIVATE_FILE_MODE);
    return absolutePath; // already exists: leave it untouched
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (dryRun) return templatePath;

  const template = await readFile(templatePath, 'utf8');
  await ensurePrivateDirectory(path.dirname(absolutePath));
  try {
    await writeFile(absolutePath, template, {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
  } catch (err) {
    // Another init/poll may have seeded this repository after our initial
    // existence check. Its file wins; never overwrite content that may
    // already have been customized.
    if (err.code !== 'EEXIST') throw err;
  }
  await enforcePrivateMode(absolutePath, PRIVATE_FILE_MODE);
  return absolutePath;
}

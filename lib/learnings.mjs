import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeGitHubAccount,
  normalizeBitbucketAccount,
  accountProvider,
  normalizeBitbucketRepository,
  normalizeRepository,
} from './config.mjs';
import { userPath } from './paths.mjs';
import {
  enforcePrivateMode,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';

export function learningsPathFor(account, repo) {
  const isBitbucket = accountProvider(account) === 'bitbucket';
  const normalized = isBitbucket
    ? normalizeBitbucketAccount(account)
    : normalizeGitHubAccount(account);
  const hostname = normalized.hostname;
  const identity = isBitbucket ? normalized.accountId : normalized.username;
  const [owner, name] = (isBitbucket
    ? normalizeBitbucketRepository(repo)
    : normalizeRepository(repo)
  ).toLowerCase().split('/');
  return userPath(
    'docs',
    'learnings',
    hostname,
    identity.toLowerCase(),
    owner,
    `${name}.md`,
  );
}

export async function ensureLearningsFile(account, repo) {
  const filePath = learningsPathFor(account, repo);
  await ensurePrivateDirectory(path.dirname(filePath));
  try {
    await writeFile(filePath, '', {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  await enforcePrivateMode(filePath, PRIVATE_FILE_MODE);
  return filePath;
}

export async function readLearnings(
  account,
  repo,
  { hardenPermissions = true } = {},
) {
  const filePath = learningsPathFor(account, repo);
  try {
    const contents = await readFile(filePath, 'utf8');
    if (hardenPermissions) {
      await enforcePrivateMode(filePath, PRIVATE_FILE_MODE);
    }
    return contents;
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

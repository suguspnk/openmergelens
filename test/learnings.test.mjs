import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ensureLearningsFile,
  learningsPathFor,
  readLearnings,
} from '../lib/learnings.mjs';
import { createTestHome, setProcessTestHome } from './test-home.mjs';

test('learnings are isolated by host, account, and repository', async (t) => {
  const home = await createTestHome(t, 'openmergelens-learnings-');
  setProcessTestHome(t, home);

  const work = { hostname: 'github.com', username: 'Work-User' };
  const personal = { hostname: 'github.com', username: 'personal' };
  assert.notEqual(
    learningsPathFor(work, 'owner/repo'),
    learningsPathFor(personal, 'owner/repo'),
  );
  assert.notEqual(
    learningsPathFor(work, 'owner/repo'),
    learningsPathFor(work, 'owner/other'),
  );

  const filePath = await ensureLearningsFile(work, 'Owner/Repo');
  assert.equal(await readFile(filePath, 'utf8'), '');
  await writeFile(filePath, 'keep this correction\n');
  await ensureLearningsFile(work, 'owner/repo');
  assert.equal(await readLearnings(work, 'owner/repo'), 'keep this correction\n');
  assert.equal(await readLearnings(personal, 'owner/repo'), '');
});

test('read-only learnings reads do not create or harden local files', {
  skip: process.platform === 'win32',
}, async (t) => {
  const home = await createTestHome(t, 'openmergelens-learnings-readonly-');
  setProcessTestHome(t, home);

  const account = { hostname: 'github.com', username: 'work' };
  const missingPath = learningsPathFor(account, 'owner/missing');
  assert.equal(
    await readLearnings(account, 'owner/missing', { hardenPermissions: false }),
    '',
  );
  await assert.rejects(stat(missingPath), { code: 'ENOENT' });

  const existingPath = learningsPathFor(account, 'owner/repo');
  await mkdir(path.dirname(existingPath), { recursive: true });
  await writeFile(existingPath, 'keep this correction\n');
  await chmod(existingPath, 0o644);
  assert.equal(
    await readLearnings(account, 'owner/repo', { hardenPermissions: false }),
    'keep this correction\n',
  );
  assert.equal((await stat(existingPath)).mode & 0o777, 0o644);

  await readLearnings(account, 'owner/repo');
  assert.equal((await stat(existingPath)).mode & 0o777, 0o600);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  atomicWrite,
  createPollReport,
  formatReportChoice,
  groupReportEntries,
  listReports,
  openReport,
  pruneReports,
  renderReportDocument,
  reportEntries,
  resolveReportPath,
} from '../lib/reports.mjs';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

function virtualFileOperations(initialFiles) {
  const files = new Map(initialFiles);
  return {
    files,
    async write(filePath, contents) {
      assert.equal(files.has(filePath), false);
      files.set(filePath, contents);
    },
    async move(sourcePath, targetPath) {
      if (!files.has(sourcePath)) {
        const error = new Error(`missing ${sourcePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      if (files.has(targetPath)) {
        const error = new Error(`existing ${targetPath}`);
        error.code = 'EEXIST';
        throw error;
      }
      files.set(targetPath, files.get(sourcePath));
      files.delete(sourcePath);
    },
    async remove(filePath) {
      files.delete(filePath);
    },
    async secure() {},
  };
}

function result(status = 'reviewed', overrides = {}) {
  return {
    outcomes: [{
      status,
      repo: 'owner/repo',
      number: 42,
      title: 'Improve report notifications',
      account: 'work@github.com',
      hostname: 'github.com',
      url: 'https://github.com/owner/repo/pull/42',
      ...overrides,
    }],
    failures: [],
  };
}

test('report entries contain only PR outcomes and order attention first', () => {
  const entries = reportEntries({
    outcomes: [
      result('reviewed').outcomes[0],
      result('re-reviewed', { number: 2 }).outcomes[0],
      result('deferred', { number: 5 }).outcomes[0],
    ],
    failures: [
      { status: 'failed', subject: 'review queue', note: 'not a PR' },
      result('failed', { number: 3 }).outcomes[0],
      result('tracking-failed', { number: 4 }).outcomes[0],
    ],
  });

  assert.deepEqual(
    entries.map((entry) => [entry.status, entry.number]),
    [
      ['tracking-failed', 4],
      ['failed', 3],
      ['deferred', 5],
      ['re-reviewed', 2],
      ['reviewed', 42],
    ],
  );
});

test('report entries retain queue deferrals alongside pull request outcomes', () => {
  const entries = reportEntries({
    outcomes: [
      result('reviewed').outcomes[0],
      {
        status: 'deferred',
        subject: 'review queue',
        note: '1 candidate(s) deferred by metadata budget',
      },
    ],
  });

  assert.deepEqual(
    entries.map(({ kind, status, repo, number, title, note }) => ({
      kind,
      status,
      repo,
      number,
      title,
      note,
    })),
    [
      {
        kind: 'summary',
        status: 'deferred',
        repo: null,
        number: null,
        title: 'review queue',
        note: '1 candidate(s) deferred by metadata budget',
      },
      {
        kind: 'pull-request',
        status: 'reviewed',
        repo: 'owner/repo',
        number: 42,
        title: 'Improve report notifications',
        note: '',
      },
    ],
  );
});

test('report entries group by account, then repository, without changing entry order', () => {
  const entries = reportEntries({
    outcomes: [
      result('reviewed', {
        account: 'work@github.com',
        repo: 'owner/service',
        number: 1,
      }).outcomes[0],
      result('reviewed', {
        account: 'personal@github.com',
        repo: 'owner/site',
        number: 2,
      }).outcomes[0],
      result('reviewed', {
        account: 'work@github.com',
        repo: 'owner/service',
        number: 3,
      }).outcomes[0],
      result('reviewed', {
        account: 'work@github.com',
        repo: 'owner/cli',
        number: 4,
      }).outcomes[0],
      result('reviewed', {
        account: '',
        repo: 'owner/unassigned',
        number: 5,
      }).outcomes[0],
    ],
  });

  assert.deepEqual(
    groupReportEntries(entries).map((accountGroup) => ({
      account: accountGroup.account,
      entries: accountGroup.entries.map((entry) => entry.number),
      repositories: accountGroup.repositories.map((repositoryGroup) => ({
        repo: repositoryGroup.repo,
        entries: repositoryGroup.entries.map((entry) => entry.number),
      })),
    })),
    [
      {
        account: 'work@github.com',
        entries: [1, 3, 4],
        repositories: [
          { repo: 'owner/service', entries: [1, 3] },
          { repo: 'owner/cli', entries: [4] },
        ],
      },
      {
        account: 'personal@github.com',
        entries: [2],
        repositories: [{ repo: 'owner/site', entries: [2] }],
      },
      {
        account: 'Unspecified account',
        entries: [5],
        repositories: [{ repo: 'owner/unassigned', entries: [5] }],
      },
    ],
  );
});

test('report rendering presents account and repository hierarchy without repeated context', () => {
  const entries = reportEntries({
    outcomes: [
      result('reviewed', {
        account: 'work@github.com',
        repo: 'owner/service',
        number: 1,
      }).outcomes[0],
      result('reviewed', {
        account: 'work@github.com',
        repo: 'owner/service',
        number: 2,
      }).outcomes[0],
      result('reviewed', {
        account: 'work@github.com',
        repo: 'owner/cli',
        number: 3,
      }).outcomes[0],
      result('reviewed', {
        account: 'personal@github.com',
        repo: 'owner/site',
        number: 4,
      }).outcomes[0],
    ],
  });
  const html = renderReportDocument({
    generatedAt: '2026-07-31T08:00:00.000Z',
    entries,
  });

  assert.match(html, /class="account-group" aria-labelledby="account-0"/);
  assert.match(html, /class="repository-group" aria-labelledby="repository-0-0"/);
  assert.equal(html.match(/work@github\.com/g)?.length, 1);
  assert.equal(html.match(/owner\/service/g)?.length, 1);
  assert.doesNotMatch(html, /as work@github\.com/);
  assert.ok(html.indexOf('work@github.com') < html.indexOf('owner/service'));
  assert.ok(html.indexOf('owner/service') < html.indexOf('class="pr-number">#1'));
  assert.ok(html.indexOf('owner/service') < html.indexOf('class="pr-number">#2'));
  assert.ok(html.indexOf('owner/cli') < html.indexOf('class="pr-number">#3'));
  assert.ok(html.indexOf('personal@github.com') < html.indexOf('owner/site'));
  assert.ok(html.indexOf('owner/site') < html.indexOf('class="pr-number">#4'));
});

test('report rendering escapes untrusted PR text and rejects unsafe URLs', () => {
  const entries = reportEntries(result('reviewed', {
    account: 'work<script>@github.com',
    repo: 'owner/<repo>',
    title: '<script>alert("x")</script>',
    note: '<img src=x onerror=alert(1)>',
    url: 'javascript:alert(1)',
  }));
  const html = renderReportDocument({
    generatedAt: '2026-07-31T08:00:00.000Z',
    entries,
  });

  assert.doesNotMatch(html, /<script>|<img src=x|javascript:/i);
  assert.match(html, /work&lt;script&gt;@github\.com/);
  assert.match(html, /owner\/&lt;repo&gt;/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /Link unavailable/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /referrer" content="no-referrer/);
  assert.doesNotMatch(html, /<script/i);
});

test('report rendering links canonical HTTPS PR URLs without external assets or scripts', () => {
  const entries = reportEntries(result());
  const html = renderReportDocument({
    generatedAt: '2026-07-31T08:00:00.000Z',
    entries,
  });

  assert.match(html, /href="https:\/\/github\.com\/owner\/repo\/pull\/42"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /#69dbb7/i);
  assert.doesNotMatch(html, /https?:\/\/[^"]+\.(?:css|js|woff)/i);
  assert.doesNotMatch(html, /<script/i);
});

test('report rendering rejects HTTPS links outside the expected host and PR path', () => {
  for (const url of [
    'https://example.com/owner/repo/pull/42',
    'https://github.com:444/owner/repo/pull/42',
    'https://github.com/other/repo/pull/42',
    'https://github.com/owner/repo/pull/99',
  ]) {
    const html = renderReportDocument({
      generatedAt: '2026-07-31T08:00:00.000Z',
      entries: reportEntries(result('reviewed', { url })),
    });
    assert.doesNotMatch(html, /href=/);
    assert.match(html, /Link unavailable/);
  }
});

test('atomic report writes replace existing Windows files through a private backup', async () => {
  const targetPath = 'C:\\reports\\report.html';
  const operations = virtualFileOperations([[targetPath, 'original']]);

  await atomicWrite(targetPath, 'replacement', {
    platform: 'win32',
    ...operations,
  });

  assert.equal(operations.files.get(targetPath), 'replacement');
  assert.equal(
    [...operations.files.keys()].some((filePath) => filePath.includes('.backup-')),
    false,
  );
});

test('failed Windows report replacement restores the original file', async () => {
  const targetPath = 'C:\\reports\\report.html';
  const operations = virtualFileOperations([[targetPath, 'original']]);
  const move = operations.move;
  let replacementAttempts = 0;
  operations.move = async (sourcePath, destinationPath) => {
    if (
      sourcePath.includes('.tmp-') &&
      destinationPath === targetPath
    ) {
      replacementAttempts += 1;
      if (replacementAttempts === 2) {
        const error = new Error('replacement failed');
        error.code = 'EIO';
        throw error;
      }
    }
    return move(sourcePath, destinationPath);
  };

  await assert.rejects(
    atomicWrite(targetPath, 'replacement', {
      platform: 'win32',
      ...operations,
    }),
    /replacement failed/,
  );

  assert.equal(operations.files.get(targetPath), 'original');
  assert.equal(
    [...operations.files.keys()].some((filePath) => filePath.includes('.backup-')),
    false,
  );
});

test('creating a report writes private paired files and lists it newest first', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-reports-'));
  t.after(() => import('node:fs/promises').then(({ rm }) =>
    rm(directory, { recursive: true, force: true })));

  const created = await createPollReport(result(), {
    reportsDirectory: directory,
    now: new Date('2026-07-31T08:00:00.000Z'),
    createId: () => FIRST_ID,
  });
  const reports = await listReports(directory);

  assert.equal(created.id, FIRST_ID);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].firstPullRequest, 'owner/repo#42');
  assert.equal(reports[0].total, 1);
  if (process.platform !== 'win32') {
    assert.equal(
      (await stat(path.join(directory, `${FIRST_ID}.html`))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await stat(path.join(directory, `${FIRST_ID}.json`))).mode & 0o777,
      0o600,
    );
  }
});

test('mixed reports retain queue deferrals without weakening PR URL handling', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-reports-'));
  t.after(() => import('node:fs/promises').then(({ rm }) =>
    rm(directory, { recursive: true, force: true })));

  const created = await createPollReport({
    outcomes: [
      result().outcomes[0],
      {
        status: 'deferred',
        subject: 'review queue',
        note: '1 candidate(s) deferred by metadata budget',
      },
    ],
  }, {
    reportsDirectory: directory,
    createId: () => FIRST_ID,
  });
  const html = await readFile(created.path, 'utf8');

  assert.equal(created.firstPullRequest, 'owner/repo#42');
  assert.equal(created.total, 2);
  assert.match(html, /review queue/);
  assert.match(html, /1 candidate\(s\) deferred by metadata budget/);
  assert.match(html, /href="https:\/\/github\.com\/owner\/repo\/pull\/42"/);
});

test('deferral-only polls create a retained report with the queue note', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-reports-'));
  t.after(() => import('node:fs/promises').then(({ rm }) =>
    rm(directory, { recursive: true, force: true })));

  const created = await createPollReport({
    outcomes: [{
      status: 'deferred',
      subject: 'review queue',
      note: '1 candidate(s) deferred by metadata budget',
    }],
  }, {
    reportsDirectory: directory,
    createId: () => SECOND_ID,
  });
  const html = await readFile(created.path, 'utf8');

  assert.equal(created.firstPullRequest, 'review queue');
  assert.equal(created.total, 1);
  assert.match(html, /Poll summary/);
  assert.match(html, /review queue/);
  assert.match(html, /1 candidate\(s\) deferred by metadata budget/);
});

test('report creation ignores generic failures with no pull request identity', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-reports-'));
  t.after(() => import('node:fs/promises').then(({ rm }) =>
    rm(directory, { recursive: true, force: true })));

  const created = await createPollReport({
    failures: [{
      status: 'failed',
      subject: 'OpenMergeLens',
      note: 'startup failed',
    }],
  }, {
    reportsDirectory: directory,
  });

  assert.equal(created, null);
});

test('pruning replaces expired snapshots with bounded expiry pages', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-reports-'));
  t.after(() => import('node:fs/promises').then(({ rm }) =>
    rm(directory, { recursive: true, force: true })));

  await createPollReport(result(), {
    reportsDirectory: directory,
    now: new Date('2026-07-30T08:00:00.000Z'),
    createId: () => FIRST_ID,
  });
  await createPollReport(result('re-reviewed', { number: 43 }), {
    reportsDirectory: directory,
    now: new Date('2026-07-31T08:00:00.000Z'),
    createId: () => SECOND_ID,
  });
  const retained = await pruneReports(directory, {
    now: new Date('2026-07-31T08:00:00.000Z'),
    limit: 1,
  });

  assert.deepEqual(retained.map((report) => report.id), [SECOND_ID]);
  assert.match(
    await readFile(path.join(directory, `${FIRST_ID}.html`), 'utf8'),
    /Report expired/,
  );
  const expiredPath = await resolveReportPath(directory, FIRST_ID);
  assert.match(expiredPath, new RegExp(`${FIRST_ID}\\.html$`));
  const opened = [];
  await openReport(directory, FIRST_ID, {
    openFile: async (filePath) => opened.push(filePath),
  });
  assert.deepEqual(opened, [expiredPath]);
});

test('report recovery rejects invalid IDs and arbitrary incomplete HTML', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-reports-'));
  t.after(() => import('node:fs/promises').then(({ rm }) =>
    rm(directory, { recursive: true, force: true })));

  await writeFile(path.join(directory, `${FIRST_ID}.html`), '<!doctype html>');

  await assert.rejects(
    resolveReportPath(directory, FIRST_ID),
    /unavailable or expired/,
  );
  await assert.rejects(
    resolveReportPath(directory, SECOND_ID),
    /unavailable or expired/,
  );
  await assert.rejects(
    resolveReportPath(directory, 'not-a-report-id'),
    /invalid report ID/,
  );
});

test('opening reports defaults to latest and supports exact retained IDs', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-reports-'));
  t.after(() => import('node:fs/promises').then(({ rm }) =>
    rm(directory, { recursive: true, force: true })));
  await createPollReport(result(), {
    reportsDirectory: directory,
    now: new Date('2026-07-30T08:00:00.000Z'),
    createId: () => FIRST_ID,
  });
  await createPollReport(result('reviewed', { number: 43 }), {
    reportsDirectory: directory,
    now: new Date('2026-07-31T08:00:00.000Z'),
    createId: () => SECOND_ID,
  });

  const opened = [];
  await openReport(directory, undefined, {
    openFile: async (filePath) => opened.push(filePath),
  });
  await openReport(directory, FIRST_ID, {
    openFile: async (filePath) => opened.push(filePath),
  });

  assert.match(opened[0], new RegExp(`${SECOND_ID}\\.html$`));
  assert.match(opened[1], new RegExp(`${FIRST_ID}\\.html$`));
});

test('report choices include time, counts, attention, and first PR', () => {
  const label = formatReportChoice({
    generatedAt: '2026-07-31T08:00:00.000Z',
    total: 4,
    attention: 1,
    summary: '3 reviewed, 1 failed',
    firstPullRequest: 'owner/repo#42',
  });
  assert.equal(label.split(' | ').length, 3);
  assert.match(label, /3 reviewed, 1 failed/);
  assert.match(label, /owner\/repo#42 \+3 more/);
});

test('listing ignores tampered metadata that could inject terminal controls', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-reports-'));
  t.after(() => import('node:fs/promises').then(({ rm }) =>
    rm(directory, { recursive: true, force: true })));
  await writeFile(path.join(directory, `${FIRST_ID}.html`), '<!doctype html>');
  await writeFile(path.join(directory, `${FIRST_ID}.json`), JSON.stringify({
    version: 1,
    id: FIRST_ID,
    generatedAt: '2026-07-31T08:00:00.000Z',
    total: 1,
    attention: 0,
    summary: '\u001b[31mspoofed',
    firstPullRequest: 'owner/repo#42',
  }));

  assert.deepEqual(await listReports(directory), []);
});

test('pruning cleans partial, temporary, and symlinked report artifacts', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openmergelens-reports-'));
  t.after(() => import('node:fs/promises').then(({ rm }) =>
    rm(directory, { recursive: true, force: true })));
  const partialJson = path.join(directory, `${FIRST_ID}.json`);
  const orphanHtml = path.join(directory, `${FIRST_ID}.html`);
  const symlinkId = '33333333-3333-4333-8333-333333333333';
  const symlinkHtml = path.join(directory, `${symlinkId}.html`);
  const temporary = path.join(
    directory,
    `${SECOND_ID}.json.tmp-123-44444444-4444-4444-8444-444444444444`,
  );
  const backup = path.join(
    directory,
    `${SECOND_ID}.html.backup-123-55555555-5555-4555-8555-555555555555`,
  );
  await writeFile(partialJson, '{}');
  await writeFile(orphanHtml, '<script>unsafe()</script>');
  await symlink('/tmp/outside.html', symlinkHtml);
  await writeFile(temporary, 'partial');
  await writeFile(backup, 'stale backup');

  await pruneReports(directory, {
    now: new Date('2026-07-31T08:00:00.000Z'),
  });

  await assert.rejects(lstat(partialJson));
  await assert.rejects(lstat(symlinkHtml));
  await assert.rejects(lstat(temporary));
  await assert.rejects(lstat(backup));
  assert.match(await readFile(orphanHtml, 'utf8'), /Report expired/);
  assert.doesNotMatch(await readFile(orphanHtml, 'utf8'), /unsafe\(\)/);
});

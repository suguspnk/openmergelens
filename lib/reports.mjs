import { randomUUID } from 'node:crypto';
import {
  lstat,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  enforcePrivateMode,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from './file-security.mjs';
import { openLocalFile } from './browser-open.mjs';

export const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const REPORT_LIMIT = 100;
export const REPORT_TOMBSTONE_LIMIT = 100;
export const REPORT_SCHEMA_VERSION = 1;

const REPORT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_TEMP_FILE_PATTERN =
  /^[0-9a-f-]+\.(?:html|json)\.tmp-\d+-[0-9a-f-]+$/i;
const REPORT_BACKUP_FILE_PATTERN =
  /^[0-9a-f-]+\.(?:html|json)\.backup-\d+-[0-9a-f-]+$/i;
const WINDOWS_REPLACE_ERRORS = new Set(['EACCES', 'EEXIST', 'EPERM']);
const REPORT_STATUSES = new Set([
  'tracking-failed',
  'failed',
  'deferred',
  're-reviewed',
  'reviewed',
  'recovered',
  'dry-run',
]);
const STATUS_LABELS = {
  'tracking-failed': 'Posted, tracking failed',
  failed: 'Failed',
  deferred: 'Deferred',
  're-reviewed': 'Re-reviewed',
  reviewed: 'Reviewed',
  recovered: 'Recovered',
  'dry-run': 'Dry run',
};
const STATUS_ORDER = [
  'tracking-failed',
  'failed',
  'deferred',
  're-reviewed',
  'reviewed',
  'recovered',
  'dry-run',
];
const ATTENTION_STATUSES = new Set(['tracking-failed', 'failed']);

function cleanText(value, maximum = 240) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safePullRequestUrl(value, { hostname, repo, number }) {
  if (!value || !hostname) return null;
  try {
    const url = new URL(value);
    const expectedPath = hostname.toLowerCase() === 'bitbucket.org'
      ? `/${repo}/pull-requests/${number}`
      : `/${repo}/pull/${number}`;
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hostname.toLowerCase() !== hostname.toLowerCase() ||
      url.pathname.toLowerCase() !== expectedPath.toLowerCase()
    ) {
      return null;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function normalizeQueueSummary(entry, sourceIndex) {
  if (
    !entry ||
    entry.status !== 'deferred' ||
    entry.subject !== 'review queue' ||
    entry.repo ||
    entry.number !== undefined
  ) {
    return null;
  }
  return {
    kind: 'summary',
    status: entry.status,
    repo: null,
    number: null,
    title: cleanText(entry.subject),
    note: cleanText(entry.note, 160),
    account: cleanText(entry.account, 160),
    url: null,
    sourceIndex,
  };
}

function normalizeEntry(entry, sourceIndex) {
  if (
    !entry ||
    !REPORT_STATUSES.has(entry.status) ||
    !entry.repo ||
    !Number.isInteger(entry.number) ||
    entry.number < 1
  ) {
    return null;
  }
  const repo = cleanText(entry.repo, 200);
  if (!repo) return null;
  const hostname = cleanText(entry.hostname, 253).toLowerCase();
  return {
    kind: 'pull-request',
    status: entry.status,
    repo,
    number: entry.number,
    title: cleanText(entry.title),
    note: cleanText(entry.note, 160),
    account: cleanText(entry.account, 160),
    url: safePullRequestUrl(entry.url, {
      hostname,
      repo,
      number: entry.number,
    }),
    sourceIndex,
  };
}

export function reportEntries({ outcomes = [], failures = [] } = {}) {
  return [...failures, ...outcomes]
    .flatMap((entry, sourceIndex) => [
      normalizeQueueSummary(entry, sourceIndex) || normalizeEntry(entry, sourceIndex),
    ])
    .filter(Boolean)
    .sort((left, right) => {
      const statusDifference =
        STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status);
      return statusDifference || left.sourceIndex - right.sourceIndex;
    });
}

function countsFor(entries) {
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
  for (const entry of entries) counts[entry.status] += 1;
  return counts;
}

export function groupReportEntries(entries) {
  const accountGroups = new Map();
  for (const entry of entries) {
    const accountName = entry.account || 'Unspecified account';
    let accountGroup = accountGroups.get(accountName);
    if (!accountGroup) {
      accountGroup = {
        account: accountName,
        entries: [],
        repositories: new Map(),
      };
      accountGroups.set(accountName, accountGroup);
    }

    accountGroup.entries.push(entry);
    let repositoryEntries = accountGroup.repositories.get(entry.repo);
    if (!repositoryEntries) {
      repositoryEntries = [];
      accountGroup.repositories.set(entry.repo, repositoryEntries);
    }
    repositoryEntries.push(entry);
  }

  return [...accountGroups.values()].map((accountGroup) => ({
    account: accountGroup.account,
    entries: accountGroup.entries,
    repositories: [...accountGroup.repositories].map(([repo, repoEntries]) => ({
      repo,
      entries: repoEntries,
    })),
  }));
}

function formatLocalTime(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function statusSummary(counts) {
  return STATUS_ORDER
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${STATUS_LABELS[status].toLowerCase()}`)
    .join(', ');
}

function renderMark() {
  return [
    '<svg class="mark" viewBox="0 0 64 64" aria-hidden="true">',
    '<rect width="64" height="64" rx="12" fill="#17212c"/>',
    '<path d="M19 18v10c0 7 5 12 12 12h14" fill="none" stroke="#69dbb7" stroke-width="6" stroke-linecap="round"/>',
    '<path d="M31 18v22" fill="none" stroke="#edf3f8" stroke-width="6" stroke-linecap="round"/>',
    '<circle cx="19" cy="17" r="5" fill="#69dbb7"/>',
    '<circle cx="31" cy="17" r="5" fill="#edf3f8"/>',
    '<circle cx="46" cy="40" r="7" fill="none" stroke="#69dbb7" stroke-width="5"/>',
    '<path d="m51 45 7 7" stroke="#69dbb7" stroke-width="5" stroke-linecap="round"/>',
    '</svg>',
  ].join('');
}

function reportStyles() {
  return `
    :root {
      color-scheme: light dark;
      --bg: #f3f6f8;
      --surface: #ffffff;
      --surface-subtle: #f8fafb;
      --border: #d8e0e6;
      --text: #17212c;
      --muted: #657382;
      --accent: #147d64;
      --accent-soft: #d9f3ea;
      --danger: #a43b45;
      --danger-soft: #fbe7e9;
      --warning: #8a5a12;
      --warning-soft: #f8edd7;
      --shadow: 0 12px 30px rgba(23, 33, 44, 0.08);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0c1117;
        --surface: #121922;
        --surface-subtle: #17212c;
        --border: #293545;
        --text: #edf3f8;
        --muted: #9eacba;
        --accent: #69dbb7;
        --accent-soft: #173b34;
        --danger: #ff9aa4;
        --danger-soft: #3f2229;
        --warning: #f0c477;
        --warning-soft: #382e20;
        --shadow: 0 16px 38px rgba(0, 0, 0, 0.24);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 280px;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.5;
    }
    main {
      width: min(760px, calc(100% - 32px));
      margin: 0 auto;
      padding: 48px 0 64px;
    }
    header {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 28px;
    }
    .mark { width: 46px; height: 46px; flex: 0 0 auto; }
    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 680;
      line-height: 1.2;
    }
    .eyebrow, .timestamp {
      margin: 2px 0 0;
      color: var(--muted);
      font-size: 13px;
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 16px;
      padding: 0;
      list-style: none;
    }
    .summary li, .status {
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface-subtle);
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      line-height: 1;
    }
    .summary li { padding: 7px 10px; }
    .summary .attention {
      border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
      background: var(--danger-soft);
      color: var(--danger);
    }
    .report-list {
      display: grid;
      gap: 14px;
    }
    .account-group {
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .account-heading, .repository-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .account-heading {
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      background: var(--surface-subtle);
    }
    .account-identity { min-width: 0; }
    .account-label {
      display: block;
      margin-bottom: 2px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      line-height: 1.2;
    }
    .account-name {
      margin: 0;
      color: var(--text);
      font-size: 15px;
      font-weight: 680;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .group-count {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .repository-group + .repository-group {
      border-top: 1px solid var(--border);
    }
    .repository-heading {
      min-height: 42px;
      padding: 10px 18px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--surface-subtle) 55%, var(--surface));
    }
    .repository-name {
      min-width: 0;
      margin: 0;
      color: var(--muted);
      font: 650 13px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace;
      overflow-wrap: anywhere;
    }
    .entry {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      min-height: 76px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
    }
    .entry-list .entry:last-child { border-bottom: 0; }
    .entry-main { min-width: 0; }
    .entry-topline {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 5px;
    }
    .status { padding: 5px 7px; }
    .status.attention {
      border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
      background: var(--danger-soft);
      color: var(--danger);
    }
    .status.recovered,
    .status.deferred {
      border-color: color-mix(in srgb, var(--warning) 35%, var(--border));
      background: var(--warning-soft);
      color: var(--warning);
    }
    .pr-number {
      color: var(--muted);
      font: 600 12px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
      overflow-wrap: anywhere;
    }
    .title {
      margin: 0;
      color: var(--text);
      font-size: 15px;
      font-weight: 620;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .meta {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .open-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      padding: 7px 11px;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--accent);
      font-size: 13px;
      font-weight: 680;
      text-decoration: none;
      white-space: nowrap;
    }
    .open-link:hover { background: var(--accent-soft); }
    .open-link span { margin-left: 4px; }
    .open-link:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent);
      outline-offset: 2px;
    }
    .unavailable {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    footer {
      margin-top: 18px;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }
    @media (max-width: 560px) {
      main {
        width: min(100% - 20px, 760px);
        padding: 24px 0 40px;
      }
      header { margin-bottom: 22px; }
      .account-heading, .repository-heading {
        align-items: flex-start;
        padding-left: 15px;
        padding-right: 15px;
      }
      .entry {
        grid-template-columns: 1fr;
        gap: 12px;
        padding: 15px;
      }
      .open-link { width: 100%; }
      .unavailable { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; }
    }
  `;
}

function renderEntry(entry) {
  const statusClass = ATTENTION_STATUSES.has(entry.status)
    ? ' attention'
    : entry.status === 'recovered'
      ? ' recovered'
      : entry.status === 'deferred'
        ? ' deferred'
        : '';
  const action = entry.url
    ? `<a class="open-link" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">Open PR <span aria-hidden="true">↗</span></a>`
    : '<span class="unavailable">Link unavailable</span>';
  const number = Number.isInteger(entry.number)
    ? `<span class="pr-number">#${entry.number}</span>`
    : '';
  return `
    <article class="entry">
      <div class="entry-main">
        <div class="entry-topline">
          <span class="status${statusClass}">${escapeHtml(STATUS_LABELS[entry.status])}</span>
          ${number}
        </div>
        <p class="title">${escapeHtml(entry.title || (entry.kind === 'summary' ? 'Untitled poll result' : 'Untitled pull request'))}</p>
        ${entry.note ? `<p class="meta">${escapeHtml(entry.note)}</p>` : ''}
      </div>
      ${action}
    </article>
  `;
}

function resultCountLabel(entries) {
  const pullRequestOnly = entries.every((entry) => entry.kind === 'pull-request');
  const noun = pullRequestOnly ? 'pull request' : 'result';
  return `${entries.length} ${noun}${entries.length === 1 ? '' : 's'}`;
}

function renderEntryGroups(entries) {
  return groupReportEntries(entries)
    .map((accountGroup, accountIndex) => {
      const accountHeadingId = `account-${accountIndex}`;
      const repositories = accountGroup.repositories
        .map((repositoryGroup, repositoryIndex) => {
          const repositoryHeadingId = `repository-${accountIndex}-${repositoryIndex}`;
          return `
        <section class="repository-group" aria-labelledby="${repositoryHeadingId}">
          <div class="repository-heading">
            <h3 class="repository-name" id="${repositoryHeadingId}">${escapeHtml(repositoryGroup.repo || 'Poll summary')}</h3>
            <span class="group-count">${escapeHtml(resultCountLabel(repositoryGroup.entries))}</span>
          </div>
          <div class="entry-list">
            ${repositoryGroup.entries.map((entry) => renderEntry(entry)).join('')}
          </div>
        </section>`;
        })
        .join('');
      return `
      <section class="account-group" aria-labelledby="${accountHeadingId}">
        <div class="account-heading">
          <div class="account-identity">
            <span class="account-label">GitHub account</span>
            <h2 class="account-name" id="${accountHeadingId}">${escapeHtml(accountGroup.account)}</h2>
          </div>
          <span class="group-count">${escapeHtml(resultCountLabel(accountGroup.entries))}</span>
        </div>
        ${repositories}
      </section>`;
    })
    .join('');
}

export function renderReportDocument({
  generatedAt,
  entries,
  counts = countsFor(entries),
} = {}) {
  const localTime = formatLocalTime(generatedAt);
  const summaryItems = STATUS_ORDER
    .filter((status) => counts[status] > 0)
    .map((status) => {
      const attentionClass = ATTENTION_STATUSES.has(status) ? ' class="attention"' : '';
      return `<li${attentionClass}>${counts[status]} ${escapeHtml(STATUS_LABELS[status])}</li>`;
    })
    .join('');
  const reportLabel = entries.some((entry) => entry.kind === 'summary')
    ? 'Poll results'
    : 'Pull request results';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none';">
  <title>OpenMergeLens review report</title>
  <style>${reportStyles()}</style>
</head>
<body>
  <main>
    <header>
      ${renderMark()}
      <div>
        <h1>Review report</h1>
        <p class="timestamp">Completed ${escapeHtml(localTime)}</p>
      </div>
    </header>
    <ul class="summary" aria-label="Poll outcome summary">${summaryItems}</ul>
    <section class="report-list" aria-label="${reportLabel}">
      ${renderEntryGroups(entries)}
    </section>
    <footer>Generated locally by OpenMergeLens · ${escapeHtml(resultCountLabel(entries))}</footer>
  </main>
</body>
</html>
`;
}

export function renderExpiredReportDocument() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';">
  <title>OpenMergeLens report expired</title>
  <style>${reportStyles()}</style>
</head>
<body>
  <main>
    <header>${renderMark()}<div><h1>Report expired</h1><p class="eyebrow">This notification refers to a report that is no longer retained.</p></div></header>
    <section class="report-list"><article class="account-group"><div class="entry-list"><div class="entry"><div class="entry-main"><p class="title">The report was removed by OpenMergeLens’s retention policy.</p><p class="meta">Run <code>openmergelens report --list</code> to choose from the reports that are still available.</p></div></div></div></article></section>
  </main>
</body>
</html>
`;
}

function reportPaths(reportsDirectory, id) {
  return {
    htmlPath: path.join(reportsDirectory, `${id}.html`),
    metadataPath: path.join(reportsDirectory, `${id}.json`),
  };
}

export async function atomicWrite(
  targetPath,
  contents,
  {
    platform = process.platform,
    write = writeFile,
    move = rename,
    remove = rm,
    secure = enforcePrivateMode,
  } = {},
) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await write(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    try {
      await move(temporaryPath, targetPath);
    } catch (error) {
      if (
        platform !== 'win32' ||
        !WINDOWS_REPLACE_ERRORS.has(error.code)
      ) {
        throw error;
      }

      const backupPath =
        `${targetPath}.backup-${process.pid}-${randomUUID()}`;
      await move(targetPath, backupPath);
      try {
        await move(temporaryPath, targetPath);
      } catch (replacementError) {
        try {
          await move(backupPath, targetPath);
        } catch (rollbackError) {
          throw new AggregateError(
            [replacementError, rollbackError],
            `failed to replace and restore ${targetPath}`,
          );
        }
        throw replacementError;
      }
      try {
        await remove(backupPath, { force: true });
      } catch {
        // The replacement is complete. A private backup is safer than
        // reporting failure and discarding the newly created poll report.
      }
    }
    await secure(targetPath, PRIVATE_FILE_MODE);
  } finally {
    await remove(temporaryPath, { force: true });
  }
}

function validateMetadata(value, expectedId) {
  if (
    !value ||
    value.version !== REPORT_SCHEMA_VERSION ||
    value.id !== expectedId ||
    !REPORT_ID_PATTERN.test(value.id) ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !Number.isInteger(value.total) ||
    value.total < 1 ||
    !Number.isInteger(value.attention) ||
    value.attention < 0 ||
    value.attention > value.total ||
    typeof value.summary !== 'string' ||
    typeof value.firstPullRequest !== 'string'
  ) {
    throw new Error(`invalid report metadata for ${expectedId}`);
  }
  if (
    cleanText(value.summary, 500) !== value.summary ||
    cleanText(value.firstPullRequest, 240) !== value.firstPullRequest
  ) {
    throw new Error(`unsafe report metadata for ${expectedId}`);
  }
  return value;
}

async function readMetadata(metadataPath, id) {
  const details = await lstat(metadataPath);
  if (!details.isFile()) {
    throw new Error(`invalid report metadata for ${id}`);
  }
  const raw = await readFile(metadataPath, 'utf8');
  return validateMetadata(JSON.parse(raw), id);
}

async function isReportTombstone(htmlPath) {
  try {
    const details = await lstat(htmlPath);
    if (!details.isFile()) return false;
    return (await readFile(htmlPath, 'utf8')) === renderExpiredReportDocument();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function listReports(
  reportsDirectory,
  {
    readDirectory = readdir,
  } = {},
) {
  let directoryEntries;
  try {
    directoryEntries = await readDirectory(reportsDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const reports = [];
  await Promise.all(directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      const id = entry.name.slice(0, -'.json'.length);
      if (!REPORT_ID_PATTERN.test(id)) return;
      try {
        const metadata = await readMetadata(
          path.join(reportsDirectory, entry.name),
          id,
        );
        const htmlDetails = await lstat(reportPaths(reportsDirectory, id).htmlPath);
        if (!htmlDetails.isFile()) return;
        reports.push(metadata);
      } catch {
        // Ignore partial or malformed report pairs. Pruning removes them.
      }
    }));
  return reports.sort(
    (left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt),
  );
}

async function cleanPartialReportArtifacts(reportsDirectory, validIds) {
  const directoryEntries = await readdir(reportsDirectory, { withFileTypes: true });
  await Promise.all(directoryEntries.map(async (entry) => {
    if (!entry.isFile() && !entry.isSymbolicLink()) return;
    if (
      REPORT_TEMP_FILE_PATTERN.test(entry.name) ||
      REPORT_BACKUP_FILE_PATTERN.test(entry.name)
    ) {
      await rm(path.join(reportsDirectory, entry.name), { force: true });
      return;
    }

    const extension = path.extname(entry.name);
    if (extension !== '.html' && extension !== '.json') return;
    const id = entry.name.slice(0, -extension.length);
    if (!REPORT_ID_PATTERN.test(id) || validIds.has(id)) return;

    const filePath = path.join(reportsDirectory, entry.name);
    if (extension === '.json' || entry.isSymbolicLink()) {
      await rm(filePath, { force: true });
      return;
    }
    if (entry.isFile()) {
      await atomicWrite(filePath, renderExpiredReportDocument());
    }
  }));
}

async function pruneTombstones(
  reportsDirectory,
  activeIds,
  now,
) {
  const directoryEntries = await readdir(reportsDirectory, { withFileTypes: true });
  const tombstones = [];
  await Promise.all(directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map(async (entry) => {
      const id = entry.name.slice(0, -'.html'.length);
      if (!REPORT_ID_PATTERN.test(id) || activeIds.has(id)) return;
      const filePath = path.join(reportsDirectory, entry.name);
      const details = await stat(filePath);
      tombstones.push({ filePath, modifiedAt: details.mtimeMs });
    }));
  tombstones.sort((left, right) => right.modifiedAt - left.modifiedAt);
  await Promise.all(tombstones.map(async (tombstone, index) => {
    if (
      index >= REPORT_TOMBSTONE_LIMIT ||
      now.getTime() - tombstone.modifiedAt > REPORT_RETENTION_MS
    ) {
      await rm(tombstone.filePath, { force: true });
    }
  }));
}

export async function pruneReports(
  reportsDirectory,
  {
    now = new Date(),
    limit = REPORT_LIMIT,
    retentionMs = REPORT_RETENTION_MS,
  } = {},
) {
  const reports = await listReports(reportsDirectory);
  await cleanPartialReportArtifacts(
    reportsDirectory,
    new Set(reports.map((report) => report.id)),
  );
  const cutoff = now.getTime() - retentionMs;
  const retained = [];
  const expired = [];
  for (const report of reports) {
    if (
      retained.length < limit &&
      Date.parse(report.generatedAt) >= cutoff
    ) {
      retained.push(report);
    } else {
      expired.push(report);
    }
  }
  await Promise.all(expired.map(async (report) => {
    const paths = reportPaths(reportsDirectory, report.id);
    await atomicWrite(paths.htmlPath, renderExpiredReportDocument());
    await rm(paths.metadataPath, { force: true });
  }));

  const activeIds = new Set(retained.map((report) => report.id));
  await pruneTombstones(reportsDirectory, activeIds, now);
  return retained;
}

export async function createPollReport(
  pollResult,
  {
    reportsDirectory,
    now = new Date(),
    createId = randomUUID,
  } = {},
) {
  if (!reportsDirectory) throw new Error('reports directory is required');
  const entries = reportEntries(pollResult);
  if (entries.length === 0) return null;

  await ensurePrivateDirectory(reportsDirectory);
  const id = createId();
  if (!REPORT_ID_PATTERN.test(id)) throw new Error('report ID is invalid');
  const generatedAt = now.toISOString();
  const counts = countsFor(entries);
  const paths = reportPaths(reportsDirectory, id);
  const firstPullRequest = entries.find(
    (entry) => entry.kind === 'pull-request',
  );
  const metadata = {
    version: REPORT_SCHEMA_VERSION,
    id,
    generatedAt,
    total: entries.length,
    attention: entries.filter((entry) => ATTENTION_STATUSES.has(entry.status)).length,
    summary: statusSummary(counts),
    firstPullRequest: firstPullRequest
      ? `${firstPullRequest.repo}#${firstPullRequest.number}`
      : 'review queue',
  };

  try {
    await atomicWrite(
      paths.htmlPath,
      renderReportDocument({ generatedAt, entries, counts }),
    );
    await atomicWrite(
      paths.metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  } catch (error) {
    await Promise.all([
      rm(paths.htmlPath, { force: true }),
      rm(paths.metadataPath, { force: true }),
    ]);
    throw error;
  }
  await pruneReports(reportsDirectory, { now });
  return {
    ...metadata,
    path: paths.htmlPath,
  };
}

export function formatReportChoice(report) {
  const remaining = report.total > 1 ? ` +${report.total - 1} more` : '';
  return `${formatLocalTime(report.generatedAt)} | ${report.summary} | ${report.firstPullRequest}${remaining}`;
}

export async function resolveReportPath(reportsDirectory, id) {
  if (!REPORT_ID_PATTERN.test(id)) throw new Error(`invalid report ID "${id}"`);
  const paths = reportPaths(reportsDirectory, id);
  try {
    await readMetadata(paths.metadataPath, id);
    const htmlDetails = await lstat(paths.htmlPath);
    if (!htmlDetails.isFile()) {
      throw new Error(`report "${id}" is unavailable or expired`);
    }
    return paths.htmlPath;
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (await isReportTombstone(paths.htmlPath)) return paths.htmlPath;
      throw new Error(`report "${id}" is unavailable or expired`);
    }
    throw error;
  }
}

export async function openReport(
  reportsDirectory,
  id,
  {
    openFile = openLocalFile,
  } = {},
) {
  const reports = await listReports(reportsDirectory);
  const selectedId = id || reports[0]?.id;
  if (!selectedId) throw new Error('no retained OpenMergeLens reports are available');
  const reportPath = await resolveReportPath(reportsDirectory, selectedId);
  await openFile(reportPath);
  return reportPath;
}

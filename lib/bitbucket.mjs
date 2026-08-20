import https from 'node:https';
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { normalizeBitbucketRepository } from './config.mjs';
import { diffAnchors } from './github.mjs';
import { mutationBoundaryReason } from './review-mutation-boundary.mjs';
import {
  MAX_REVIEW_COMMENT_CHARS,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_PATH_CHARS,
  MAX_REVIEW_SUMMARY_CHARS,
  MAX_REVIEW_TOTAL_TEXT_CHARS,
} from './security-limits.mjs';

const API_HOST = 'api.bitbucket.org';
const API_PREFIX = '/2.0/';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_VALUES = 500;

function segment(value) {
  return encodeURIComponent(String(value));
}

function repoPath(repo) {
  const parts = String(repo).split('/');
  if (parts.length !== 2) throw new Error('Bitbucket repository must be WORKSPACE/REPO');
  return `repositories/${segment(parts[0])}/${segment(parts[1])}`;
}

export function bitbucketLookup(hostname, requestOptions, callback, lookup = dnsLookup) {
  return lookup(hostname, { ...requestOptions, order: 'ipv4first' }, callback);
}

export function bitbucketRequest({
  auth,
  path,
  method = 'GET',
  body,
  accept = 'application/json',
  request = https.request,
}) {
  if (typeof path !== 'string' || !path.startsWith(API_PREFIX)) {
    throw new Error('Bitbucket API path is invalid');
  }
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStream;
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    let req;
    const failResponse = (message, cause) => {
      const error = cause
        ? new Error(`${message}: ${cause.message}`, { cause })
        : new Error(message);
      rejectOnce(error);
      if (!req?.destroyed) req?.destroy();
      if (responseStream && !responseStream.destroyed) responseStream.destroy?.();
    };
    req = request({
      protocol: 'https:',
      hostname: API_HOST,
      port: 443,
      lookup: bitbucketLookup,
      autoSelectFamily: true,
      method,
      path,
      headers: {
        accept,
        authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        } : {}),
      },
    }, (response) => {
      responseStream = response;
      const chunks = [];
      let bytes = 0;
      let ended = false;
      response.on('data', (chunk) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          failResponse('Bitbucket response exceeded the size limit');
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', (error) => {
        failResponse('Bitbucket API response failed', error);
      });
      response.on('aborted', () => {
        failResponse('Bitbucket API response was aborted');
      });
      response.on('close', () => {
        if (!ended && !settled) {
          failResponse('Bitbucket API response closed before completion');
        }
      });
      response.on('end', () => {
        ended = true;
        if (settled) return;
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`Bitbucket API request failed with HTTP ${response.statusCode}`);
          error.status = response.statusCode;
          const retryAfter = Number(response.headers['retry-after']);
          if (Number.isFinite(retryAfter) && retryAfter >= 0) {
            error.retryAfterMs = retryAfter * 1000;
          }
          rejectOnce(error);
          return;
        }
        if (accept !== 'application/json') {
          resolveOnce(text);
          return;
        }
        try {
          resolveOnce(text ? JSON.parse(text) : {});
        } catch {
          rejectOnce(new Error('Bitbucket API returned invalid JSON'));
        }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Bitbucket API request timed out')));
    req.on('error', (error) => {
      rejectOnce(error);
      if (responseStream && !responseStream.destroyed) responseStream.destroy?.();
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function paginated(path, { auth, api = bitbucketRequest } = {}) {
  const values = [];
  let nextPath = path;
  const allowedPathname = new URL(`https://${API_HOST}${path}`).pathname;
  let page = 0;
  for (; nextPath && page < MAX_PAGES; page += 1) {
    const result = await api({ auth, path: nextPath });
    if (!Array.isArray(result?.values)) throw new Error('Bitbucket API page is malformed');
    const remaining = MAX_VALUES - values.length;
    if (result.values.length > remaining) {
      throw new Error('Bitbucket API pagination exceeded the value limit');
    }
    values.push(...result.values);
    if (!result.next) {
      nextPath = null;
      break;
    }
    if (values.length >= MAX_VALUES) {
      throw new Error('Bitbucket API pagination exceeded the value limit');
    }
    let next;
    try {
      next = new URL(result.next);
    } catch {
      throw new Error('Bitbucket API returned an unsafe pagination URL');
    }
    if (
      next.protocol !== 'https:' ||
      next.hostname !== API_HOST ||
      next.port ||
      next.pathname !== allowedPathname
    ) {
      throw new Error('Bitbucket API returned an unsafe pagination URL');
    }
    nextPath = `${next.pathname}${next.search}`;
  }
  if (nextPath && values.length < MAX_VALUES) {
    throw new Error('Bitbucket API pagination exceeded the page limit');
  }
  return values;
}

export async function currentBitbucketUser({ auth, api = bitbucketRequest }) {
  return api({ auth, path: '/2.0/user' });
}

export async function listAccessibleBitbucketRepos({ auth, api = bitbucketRequest }) {
  const values = await paginated(
    '/2.0/repositories?role=member&pagelen=50&sort=full_name',
    { auth, api },
  );
  return values.map((repo) => {
    if (typeof repo?.full_name !== 'string' || typeof repo.is_private !== 'boolean') {
      throw new Error('Bitbucket repository response is malformed');
    }
    let fullName;
    try {
      fullName = normalizeBitbucketRepository(repo.full_name);
    } catch {
      throw new Error('Bitbucket repository response is malformed');
    }
    if (fullName !== repo.full_name) {
      throw new Error('Bitbucket repository response is malformed');
    }
    return { nameWithOwner: fullName, isPrivate: repo.is_private };
  });
}

export async function searchBitbucketReviewRequestedPRs({ account, repo, auth, api }) {
  const values = await paginated(
    `/2.0/${repoPath(repo)}/pullrequests?state=OPEN&pagelen=50`,
    { auth, api },
  );
  return values
    .filter((pr) => pr?.reviewers?.some(
      (reviewer) => reviewer?.uuid?.toLowerCase() === account.accountId.toLowerCase(),
    ))
    .filter((pr) => Number.isSafeInteger(pr?.id) && pr.id > 0)
    .map((pr) => ({ repo, number: pr.id }));
}

export async function getBitbucketPullRequest({ repo, number, auth, api = bitbucketRequest }) {
  const pr = await api({
    auth,
    path: `/2.0/${repoPath(repo)}/pullrequests/${segment(number)}`,
  });
  const normalized = {
    headRefOid: pr?.source?.commit?.hash,
    number: pr?.id,
    title: pr?.title || '',
    url: pr?.links?.html?.href,
    body: pr?.description || '',
    baseRefName: pr?.destination?.branch?.name,
    headRefName: pr?.source?.branch?.name,
    // The poller uses the common CLOSED terminal state. Bitbucket Cloud calls
    // declined and superseded pull requests terminal too.
    state: ['DECLINED', 'SUPERSEDED'].includes(String(pr?.state || '').toUpperCase())
      ? 'CLOSED'
      : String(pr?.state || '').toUpperCase(),
  };
  // Internal mutation-boundary evidence; not part of the public normalized
  // PR shape consumed by prompt adapters.
  Object.defineProperty(normalized, 'reviewerIds', {
    value: Array.isArray(pr?.reviewers)
      ? pr.reviewers.map((reviewer) => String(reviewer?.uuid || '').toLowerCase())
      : [],
    enumerable: false,
  });
  return normalized;
}

export async function hasActiveBitbucketReviewRequest({
  repo,
  number,
  account,
  auth,
  api = bitbucketRequest,
}) {
  const pullRequest = await api({
    auth,
    path: `/2.0/${repoPath(repo)}/pullrequests/${segment(number)}`,
  });
  const accountId = String(account?.accountId || '').toLowerCase();
  return !!accountId && Array.isArray(pullRequest?.reviewers) &&
    pullRequest.reviewers.some((reviewer) =>
      String(reviewer?.uuid || '').toLowerCase() === accountId);
}

export async function getBitbucketPullRequestDiff({ repo, number, auth, api = bitbucketRequest }) {
  return api({
    auth,
    path: `/2.0/${repoPath(repo)}/pullrequests/${segment(number)}/diff`,
    accept: 'text/plain',
  });
}

export function createBitbucketReviewMarker({ account, repo, number, commitId }) {
  const identity = JSON.stringify([
    'bitbucket.org', account.accountId.toLowerCase(), repo.toLowerCase(), Number(number), commitId,
  ]);
  return `<!-- openmergelens-review:${createHash('sha256').update(identity).digest('hex')} -->`;
}

function formatFinding(finding) {
  return `**[${finding.severity}]** ${finding.comment}`;
}

function findingMarker(reviewMarker, finding) {
  const identity = JSON.stringify([
    reviewMarker,
    finding.postingIndex,
    finding.path,
    finding.line,
  ]);
  return `<!-- openmergelens-finding:${createHash('sha256').update(identity).digest('hex')} -->`;
}

export function prepareBitbucketReview({ body, comments, diff, marker, auth }) {
  if (
    !marker || typeof body !== 'string' || body.length > MAX_REVIEW_SUMMARY_CHARS ||
    !Array.isArray(comments) || comments.length > MAX_REVIEW_FINDINGS
  ) {
    throw new Error('Bitbucket review payload is invalid');
  }
  const anchors = diffAnchors(diff);
  const anchorable = [];
  const unanchorable = [];
  for (const [postingIndex, finding] of comments.entries()) {
    if (
      !finding || typeof finding.path !== 'string' || !finding.path ||
      finding.path.length > MAX_REVIEW_PATH_CHARS || /[\0\r\n]/u.test(finding.path) ||
      !Number.isSafeInteger(finding.line) || finding.line < 1 ||
      !['critical', 'major', 'nit'].includes(finding.severity) ||
      typeof finding.comment !== 'string' || !finding.comment ||
      finding.comment.length > MAX_REVIEW_COMMENT_CHARS
    ) throw new Error('Bitbucket review contains an invalid finding');
    (anchors.has(`${finding.path}:${finding.line}`) ? anchorable : unanchorable).push({
      ...finding,
      postingIndex,
    });
  }
  const summary = bitbucketSummary(body, unanchorable, marker, auth);
  if (summary.length > MAX_REVIEW_TOTAL_TEXT_CHARS) {
    throw new Error('Bitbucket review text exceeds the size limit');
  }
  return { anchorable, unanchorable, summary };
}

function bitbucketSummary(body, unanchorable, marker, auth) {
  const extra = unanchorable.length
    ? `\n\n---\n**Additional findings (could not anchor to a diff line):**\n${unanchorable.map((f) => `- ${formatSummaryLocation(f.path, f.line)} ${formatFinding(f)}`).join('\n')}`
    : '';
  const attributionIdentity = formatAttributionIdentity(auth.displayName || auth.username);
  const attribution = `🤖 **AI-generated review:** OpenMergeLens generated this review on behalf of ${attributionIdentity}. Verify findings before acting.`;
  return `${body}${extra}\n\n---\n${attribution}\n\n${marker}`;
}

const MAX_ATTRIBUTION_IDENTITY_CODE_POINTS = 128;

function formatAttributionIdentity(value) {
  const normalized = String(value || 'the configured reviewer')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/giu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const codePoints = [...(normalized || 'the configured reviewer')];
  const bounded = codePoints.length > MAX_ATTRIBUTION_IDENTITY_CODE_POINTS
    ? `${codePoints.slice(0, MAX_ATTRIBUTION_IDENTITY_CODE_POINTS - 1).join('')}…`
    : codePoints.join('');
  const mentionSafe = bounded.replace(/@/gu, '@\u200B');
  const longestBacktickRun = Math.max(
    0,
    ...[...mentionSafe.matchAll(/`+/gu)].map((match) => match[0].length),
  );
  const fence = '`'.repeat(longestBacktickRun + 1);
  return `${fence} ${mentionSafe} ${fence}`;
}

const MAX_SUMMARY_LOCATION_CHARS = MAX_REVIEW_PATH_CHARS + 64;

function formatSummaryLocation(path, line) {
  const render = (pathText) => {
    // A zero-width break prevents mention expansion even if a renderer ever
    // changes how mentions inside code spans are interpreted.
    const location = `${pathText}:${line}`.replace(/@/gu, '@\u200B');
    const longestBacktickRun = Math.max(
      0,
      ...[...location.matchAll(/`+/gu)].map((match) => match[0].length),
    );
    const fence = '`'.repeat(longestBacktickRun + 1);
    return `${fence} ${location} ${fence}`;
  };
  const complete = render(path);
  if (complete.length <= MAX_SUMMARY_LOCATION_CHARS) return complete;

  // Bound Markdown expansion from adversarial runs of backticks or mentions.
  // Preserve the line and the longest safe path prefix; the original finding
  // remains in the durable posting plan for retry/reconciliation.
  let lower = 0;
  let upper = path.length;
  let bounded = render('…');
  while (lower <= upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    const candidate = render(`${path.slice(0, midpoint)}…`);
    if (candidate.length <= MAX_SUMMARY_LOCATION_CHARS) {
      bounded = candidate;
      lower = midpoint + 1;
    } else {
      upper = midpoint - 1;
    }
  }
  return bounded;
}

async function commentsFor(repo, number, auth, api) {
  return paginated(
    `/2.0/${repoPath(repo)}/pullrequests/${segment(number)}/comments?pagelen=50`,
    { auth, api },
  );
}

export async function bitbucketReviewAlreadyPosted({ repo, number, marker, auth, api }) {
  const comments = await commentsFor(repo, number, auth, api || bitbucketRequest);
  return comments.some((comment) =>
    comment?.user?.uuid?.toLowerCase() === auth.accountId.toLowerCase() &&
    comment?.content?.raw?.includes(marker),
  );
}

export async function postBitbucketReview({
  repo, number, body, comments, diff, marker, auth,
  api = bitbucketRequest, scheduleMutation,
}) {
  if (typeof scheduleMutation !== 'function') {
    throw new Error('Bitbucket review posting requires a mutation scheduler');
  }
  const prepared = prepareBitbucketReview({ body, comments, diff, marker, auth });
  // Reconciliation is a provider request too. Keep it in the account queue so
  // a rate-limited read establishes backoff before any later review can read
  // or write, and so the poller's mutation-boundary validation still runs.
  const existing = await scheduleMutation(() => commentsFor(repo, number, auth, api));
  const isOwnComment = (comment) =>
    comment?.user?.uuid?.toLowerCase() === auth.accountId.toLowerCase();
  if (existing.some((comment) => isOwnComment(comment) && comment?.content?.raw?.includes(marker))) return;
  for (const finding of prepared.anchorable) {
    const markerForFinding = findingMarker(marker, finding);
    if (existing.some((comment) => isOwnComment(comment) && comment?.content?.raw?.includes(markerForFinding))) continue;
    try {
      await scheduleMutation(() => api({
        auth,
        method: 'POST',
        path: `/2.0/${repoPath(repo)}/pullrequests/${segment(number)}/comments`,
        body: {
          content: { raw: `${formatFinding(finding)}\n\n${markerForFinding}` },
          inline: { path: finding.path, to: finding.line },
        },
      }));
    } catch (error) {
      if (mutationBoundaryReason(error)) throw error;
      if (error.status === 400 || error.status === 422) {
        prepared.unanchorable.push(finding);
        continue;
      }
      throw error;
    }
  }
  const summary = bitbucketSummary(body, prepared.unanchorable, marker, auth);
  if (summary.length > MAX_REVIEW_TOTAL_TEXT_CHARS) {
    throw new Error('Bitbucket review text exceeds the size limit');
  }
  try {
    await scheduleMutation(() => api({
      auth,
      method: 'POST',
      path: `/2.0/${repoPath(repo)}/pullrequests/${segment(number)}/comments`,
      body: { content: { raw: summary } },
    }));
  } catch (error) {
    if (mutationBoundaryReason(error)) throw error;
    // The account scheduler owns definitive rate-limit backoff. An immediate
    // reconciliation GET here would escape that queue and add load while the
    // account is blocked.
    if (error?.status === 429) throw error;
    if (await scheduleMutation(() => bitbucketReviewAlreadyPosted({
      repo, number, marker, auth, api,
    }))) return;
    throw error;
  }
}

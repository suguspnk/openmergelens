import https from 'node:https';
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import {
  normalizeBitbucketRepository,
  normalizeBitbucketWorkspace,
} from './config.mjs';
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
const MAX_DISCOVERY_WORKSPACES = 100;
const MAX_DISCOVERY_REPOSITORIES = 500;
const MAX_DISCOVERY_PAGE_REQUESTS = 112;
const MAX_REDIRECT_LOCATION_CHARS = 4_096;
const MAX_PAGINATION_URL_CHARS = 4_096;

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
  redirect,
  request = https.request,
}) {
  if (typeof path !== 'string' || !path.startsWith(API_PREFIX)) {
    throw new Error('Bitbucket API path is invalid');
  }
  if (
    redirect !== undefined &&
    (typeof redirect !== 'function' || method !== 'GET' || body !== undefined)
  ) {
    throw new Error('Bitbucket API redirect policy is invalid');
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
        if (
          !Number.isSafeInteger(response.statusCode) ||
          response.statusCode < 100 ||
          response.statusCode > 599 ||
          !response.headers ||
          typeof response.headers !== 'object'
        ) {
          rejectOnce(new Error('Bitbucket API returned a malformed HTTP response'));
          return;
        }
        if (response.statusCode === 302 && redirect) {
          let redirectPath;
          try {
            redirectPath = redirect(response.headers.location);
          } catch {
            rejectOnce(new Error('Bitbucket API returned an unsafe redirect'));
            return;
          }
          resolveOnce(bitbucketRequest({
            auth,
            path: redirectPath,
            method,
            accept,
            request,
          }));
          return;
        }
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

function bitbucketPullRequestDiffRedirect(location, { repo, number }) {
  if (
    typeof location !== 'string' ||
    !location ||
    location.length > MAX_REDIRECT_LOCATION_CHARS ||
    /[\0\r\n]/u.test(location)
  ) {
    throw new Error('Bitbucket diff redirect is invalid');
  }
  let target;
  try {
    target = new URL(location);
  } catch {
    throw new Error('Bitbucket diff redirect is invalid');
  }
  const expectedPrefix = `/2.0/${repoPath(repo)}/diff/`;
  const remainder = target.pathname.slice(expectedPrefix.length);
  const queryEntries = [...target.searchParams.entries()];
  if (
    target.protocol !== 'https:' ||
    target.hostname !== API_HOST ||
    (target.port && target.port !== '443') ||
    target.username ||
    target.password ||
    target.hash ||
    !target.pathname.startsWith(expectedPrefix) ||
    !remainder ||
    /%(?:2e|2f|5c)/iu.test(remainder) ||
    queryEntries.length !== 2 ||
    target.searchParams.getAll('from_pullrequest_id').length !== 1 ||
    target.searchParams.get('from_pullrequest_id') !== String(number) ||
    target.searchParams.getAll('topic').length !== 1 ||
    target.searchParams.get('topic') !== 'true'
  ) {
    throw new Error('Bitbucket diff redirect is invalid');
  }
  return `${target.pathname}${target.search}`;
}

async function paginated(path, {
  auth,
  api = bitbucketRequest,
  maxValues = MAX_VALUES,
  requestPage = api,
  requiredQueryParameters = [],
} = {}) {
  const values = [];
  let nextPath = path;
  const allowedPathname = new URL(`https://${API_HOST}${path}`).pathname;
  const initialUrl = new URL(`https://${API_HOST}${path}`);
  const requiredQueries = new Map(requiredQueryParameters.map((name) => [
    name,
    initialUrl.searchParams.getAll(name),
  ]));
  if ([...requiredQueries.values()].some((values) => values.length !== 1)) {
    throw new Error('Bitbucket API pagination policy is invalid');
  }
  let page = 0;
  for (; nextPath && page < MAX_PAGES; page += 1) {
    const result = await requestPage({ auth, path: nextPath });
    if (!Array.isArray(result?.values)) throw new Error('Bitbucket API page is malformed');
    const remaining = maxValues - values.length;
    if (result.values.length > remaining) {
      throw new Error('Bitbucket API pagination exceeded the value limit');
    }
    values.push(...result.values);
    if (!result.next) {
      nextPath = null;
      break;
    }
    if (values.length >= maxValues) {
      throw new Error('Bitbucket API pagination exceeded the value limit');
    }
    if (
      typeof result.next !== 'string' ||
      !result.next ||
      result.next.length > MAX_PAGINATION_URL_CHARS ||
      /[\0\r\n]/u.test(result.next)
    ) {
      throw new Error('Bitbucket API returned an unsafe pagination URL');
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
      next.username ||
      next.password ||
      next.hash ||
      next.pathname !== allowedPathname ||
      [...requiredQueries].some(([name, values]) => {
        const supplied = next.searchParams.getAll(name);
        return supplied.length !== 1 || supplied[0] !== values[0];
      })
    ) {
      throw new Error('Bitbucket API returned an unsafe pagination URL');
    }
    nextPath = `${next.pathname}${next.search}`;
  }
  if (nextPath && values.length < maxValues) {
    throw new Error('Bitbucket API pagination exceeded the page limit');
  }
  return values;
}

export async function currentBitbucketUser({ auth, api = bitbucketRequest }) {
  return api({ auth, path: '/2.0/user' });
}

function discoveryFailure(error, { workspace } = {}) {
  const status = Number(error?.status);
  let message = workspace
    ? `Bitbucket repository discovery failed for workspace "${workspace}"`
    : 'Bitbucket workspace discovery failed';
  if (status === 403) {
    message = workspace
      ? `Bitbucket repository discovery for workspace "${workspace}" requires ` +
        'read:repository:bitbucket; recreate the API token with this scope'
      : 'Bitbucket workspace discovery requires read:workspace:bitbucket; ' +
        'recreate the API token with this scope';
  } else if (workspace && (status === 404 || status === 410)) {
    message = `Bitbucket workspace "${workspace}" is unavailable (HTTP ${status}); ` +
      'configuration was not changed';
  } else {
    message += `: ${safeDiscoveryFailureDetail(error, status)}`;
  }
  const wrapped = new Error(message, { cause: error instanceof Error ? error : undefined });
  if (Number.isInteger(status)) wrapped.status = status;
  return wrapped;
}

function safeDiscoveryFailureDetail(error, status) {
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return `HTTP ${status}`;
  }
  const details = new Map([
    ['Bitbucket API request timed out', 'request timed out'],
    ['Bitbucket response exceeded the size limit', 'response size limit exceeded'],
    ['Bitbucket API response was aborted', 'response was aborted'],
    ['Bitbucket API response closed before completion', 'response closed before completion'],
    ['Bitbucket API returned invalid JSON', 'invalid JSON response'],
    ['Bitbucket API page is malformed', 'malformed pagination response'],
    ['Bitbucket API returned an unsafe pagination URL', 'unsafe pagination URL'],
    ['Bitbucket API pagination exceeded the value limit', 'value limit exceeded'],
    ['Bitbucket API pagination exceeded the page limit', 'page limit exceeded'],
    [
      'Bitbucket repository discovery exceeded the aggregate page limit',
      'aggregate page limit exceeded',
    ],
  ]);
  const exact = details.get(typeof error?.message === 'string' ? error.message : '');
  if (exact) return exact;

  const safeCodes = new Set([
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
    'ERR_SOCKET_CLOSED',
    'ETIMEDOUT',
  ]);
  let candidate = error;
  for (let depth = 0; candidate && depth < 3; depth += 1) {
    const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
    if (safeCodes.has(code)) {
      return code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? `DNS lookup failed (${code})`
        : `network request failed (${code})`;
    }
    candidate = candidate.cause;
  }
  if (typeof error?.message === 'string' && error.message.startsWith('Bitbucket API response failed')) {
    return 'response stream failed';
  }
  return 'unexpected provider error';
}

export async function listAccessibleBitbucketRepos({ auth, api = bitbucketRequest }) {
  let pageRequests = 0;
  const requestPage = async (options) => {
    if (pageRequests >= MAX_DISCOVERY_PAGE_REQUESTS) {
      throw new Error('Bitbucket repository discovery exceeded the aggregate page limit');
    }
    pageRequests += 1;
    return api(options);
  };
  let workspaceValues;
  try {
    workspaceValues = await paginated(
      '/2.0/user/workspaces?pagelen=50',
      { auth, api, maxValues: MAX_DISCOVERY_WORKSPACES, requestPage },
    );
  } catch (error) {
    throw discoveryFailure(error);
  }
  const workspacesByKey = new Map();
  for (const value of workspaceValues) {
    let workspace;
    try {
      workspace = normalizeBitbucketWorkspace(value?.workspace?.slug);
    } catch {
      throw new Error('Bitbucket workspace response is malformed');
    }
    if (workspace !== value.workspace.slug) {
      throw new Error('Bitbucket workspace response is malformed');
    }
    const key = workspace.toLowerCase();
    if (!workspacesByKey.has(key)) workspacesByKey.set(key, workspace);
  }

  const repositoriesByKey = new Map();
  const workspaces = [...workspacesByKey.values()].sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase()) || left.localeCompare(right));
  for (const workspace of workspaces) {
    let values;
    try {
      values = await paginated(
        `/2.0/repositories/${segment(workspace)}?role=member&pagelen=50&sort=full_name`,
        {
          auth,
          api,
          maxValues: MAX_DISCOVERY_REPOSITORIES - repositoriesByKey.size,
          requestPage,
        },
      );
    } catch (error) {
      throw discoveryFailure(error, { workspace });
    }
    for (const repo of values) {
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
      const [owner] = fullName.split('/');
      if (owner.toLowerCase() !== workspace.toLowerCase()) {
        throw new Error(`Bitbucket repository response for workspace "${workspace}" is foreign`);
      }
      const key = fullName.toLowerCase();
      const existing = repositoriesByKey.get(key);
      if (existing && (
        existing.nameWithOwner !== fullName || existing.isPrivate !== repo.is_private
      )) {
        throw new Error('Bitbucket repository response contains conflicting results');
      }
      repositoriesByKey.set(key, { nameWithOwner: fullName, isPrivate: repo.is_private });
    }
  }
  return [...repositoriesByKey.values()].sort((left, right) =>
    left.nameWithOwner.toLowerCase().localeCompare(right.nameWithOwner.toLowerCase()) ||
    left.nameWithOwner.localeCompare(right.nameWithOwner));
}

export async function searchBitbucketReviewRequestedPRs({ account, repo, auth, api }) {
  const values = await paginated(
    `/2.0/${repoPath(repo)}/pullrequests?state=OPEN&pagelen=50&fields=%2Bvalues.reviewers`,
    { auth, api, requiredQueryParameters: ['state', 'fields'] },
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
    redirect: (location) => bitbucketPullRequestDiffRedirect(location, { repo, number }),
  });
}

export function createBitbucketReviewMarker({ account, repo, number, commitId }) {
  const identity = JSON.stringify([
    'bitbucket.org', account.accountId.toLowerCase(), repo.toLowerCase(), Number(number), commitId,
  ]);
  return bitbucketMarker('review', createHash('sha256').update(identity).digest('hex'));
}

function bitbucketMarker(kind, digest) {
  return `[openmergelens-${kind}-${digest}]: #`;
}

function legacyBitbucketMarker(kind, digest) {
  return `<!-- openmergelens-${kind}:${digest} -->`;
}

function markerVariants(marker) {
  const markdown = /^\[openmergelens-(review|finding)-([a-f0-9]{64})\]: #$/u.exec(marker);
  if (markdown) {
    return [marker, legacyBitbucketMarker(markdown[1], markdown[2])];
  }
  const legacy = /^<!-- openmergelens-(review|finding):([a-f0-9]{64}) -->$/u.exec(marker);
  if (legacy) {
    return [marker, bitbucketMarker(legacy[1], legacy[2])];
  }
  return [marker];
}

function rawContainsMarker(raw, marker) {
  return typeof raw === 'string' &&
    markerVariants(marker).some((variant) => raw.includes(variant));
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
  return bitbucketMarker('finding', createHash('sha256').update(identity).digest('hex'));
}

function findingMarkerVariants(reviewMarker, finding) {
  return markerVariants(reviewMarker).flatMap((reviewMarkerVariant) =>
    markerVariants(findingMarker(reviewMarkerVariant, finding)));
}

export function prepareBitbucketReview({
  body,
  comments,
  diff,
  marker,
  auth,
  includeAttribution = true,
}) {
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
  const summary = bitbucketSummary(body, unanchorable, marker, auth, includeAttribution);
  if (summary.length > MAX_REVIEW_TOTAL_TEXT_CHARS) {
    throw new Error('Bitbucket review text exceeds the size limit');
  }
  return { anchorable, unanchorable, summary };
}

function bitbucketSummary(body, unanchorable, marker, auth, includeAttribution) {
  const extra = unanchorable.length
    ? `\n\n---\n**Additional findings (could not anchor to a diff line):**\n${unanchorable.map((f) => `- ${formatSummaryLocation(f.path, f.line)} ${formatFinding(f)}`).join('\n')}`
    : '';
  if (!includeAttribution) return `${body}${extra}\n\n${marker}`;
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
    rawContainsMarker(comment?.content?.raw, marker),
  );
}

export async function postBitbucketReview({
  repo, number, body, comments, diff, marker, auth,
  includeAttribution = true, api = bitbucketRequest, scheduleMutation,
}) {
  if (typeof scheduleMutation !== 'function') {
    throw new Error('Bitbucket review posting requires a mutation scheduler');
  }
  const prepared = prepareBitbucketReview({
    body, comments, diff, marker, auth, includeAttribution,
  });
  // Reconciliation is a provider request too. Keep it in the account queue so
  // a rate-limited read establishes backoff before any later review can read
  // or write, and so the poller's mutation-boundary validation still runs.
  const existing = await scheduleMutation(() => commentsFor(repo, number, auth, api));
  const isOwnComment = (comment) =>
    comment?.user?.uuid?.toLowerCase() === auth.accountId.toLowerCase();
  if (existing.some((comment) =>
    isOwnComment(comment) && rawContainsMarker(comment?.content?.raw, marker))) return;
  for (const finding of prepared.anchorable) {
    const markerForFinding = findingMarker(marker, finding);
    const existingFindingMarkers = findingMarkerVariants(marker, finding);
    if (existing.some((comment) =>
      isOwnComment(comment) &&
      existingFindingMarkers.some((variant) => comment?.content?.raw?.includes(variant)))) continue;
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
  const summary = bitbucketSummary(
    body,
    prepared.unanchorable,
    marker,
    auth,
    includeAttribution,
  );
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

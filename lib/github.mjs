import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { normalizeRepository } from './config.mjs';
import { authEnvironment } from './github-auth.mjs';
import {
  MAX_ACTIVE_REVIEW_REQUEST_USERS,
  MAX_GITHUB_REVIEWS_FOR_RECONCILIATION,
  MAX_GH_OUTPUT_BYTES,
  MAX_DIFF_ANCHOR_CHARS,
  MAX_DIFF_ANCHORS,
  MAX_GITHUB_REVIEW_BODY_CHARS,
  MAX_REVIEW_COMMENT_CHARS,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_PATH_CHARS,
  MAX_REVIEW_SUMMARY_CHARS,
  REVIEWER_HARD_KILL_GRACE_MS,
} from './security-limits.mjs';
import {
  terminateProcessTree,
} from './process-launch.mjs';
import {
  MAX_TIMER_DELAY_MS,
  isGitHubRateLimitError,
} from './github-mutation-queue.mjs';
import { mutationBoundaryReason } from './review-mutation-boundary.mjs';

const GH_TIMEOUT_MS = 60_000;
const GITHUB_SEARCH_PAGE_SIZE = 100;
const GITHUB_SEARCH_RESULT_LIMIT = 1_000;
const GITHUB_USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,38})$/i;
const GITHUB_BOT_LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,94})\[bot\]$/i;
const REQUESTED_REVIEWER_FIELDS = new Set(['login', 'type']);
const RECONCILIATION_REVIEW_FIELDS = new Set([
  'body',
  'commit_id',
  'state',
  'user_login',
]);
const GITHUB_REVIEW_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
]);

export function httpStatusFromDiagnostic(diagnostic) {
  const match = String(diagnostic || '').match(/\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/i);
  return match ? Number(match[1]) : undefined;
}

export function retryMetadataFromDiagnostic(diagnostic) {
  const retryAfter = String(diagnostic || '').match(
    /^retry-after:\s*(\d+|[^\r\n]+)$/im,
  )?.[1]?.trim();
  const resetAt = String(diagnostic || '').match(
    /^x-ratelimit-reset:\s*(\d+)$/im,
  )?.[1];
  let retryAfterMs;
  if (/^\d+$/.test(retryAfter || '')) {
    const retryAfterSeconds = Number(retryAfter);
    if (Number.isSafeInteger(retryAfterSeconds)) {
      retryAfterMs = Math.min(
        retryAfterSeconds * 1_000,
        MAX_TIMER_DELAY_MS,
      );
    }
  } else if (retryAfter) {
    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) {
      retryAfterMs = Math.min(
        Math.max(0, retryDate - Date.now()),
        MAX_TIMER_DELAY_MS,
      );
    }
  }
  let rateLimitResetAtMs;
  if (resetAt) {
    const resetAtSeconds = Number(resetAt);
    const parsedResetAtMs = Number.isSafeInteger(resetAtSeconds)
      ? resetAtSeconds * 1_000
      : undefined;
    if (Number.isSafeInteger(parsedResetAtMs)) {
      rateLimitResetAtMs = parsedResetAtMs;
    }
  }
  return {
    retryAfterMs,
    rateLimitResetAtMs,
  };
}

// Deliberately not execFile's `input` option: on Node 22 / macOS (confirmed
// with a minimal `cat`-only repro, no gh/network involved) execFile+input
// reproducibly hangs forever instead of resolving once the child exits;
// the write appears to never signal completion back to the wait/exit
// machinery. Piping via spawn() + manual stdin.write()/stdin.end() (the
// same pattern already used in reviewer-adapter.mjs's invokeReviewer)
// sidesteps it entirely and returns immediately once the child closes.
function ghSpawn(args, { input, timeoutMs = GH_TIMEOUT_MS, auth } = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn('gh', args, {
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: authEnvironment(auth),
    });
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdinError;
    let terminalError;
    let settled = false;
    let hardKillTimer;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKillTimer);
      callback();
    };
    const terminateWith = (error) => {
      if (terminalError || settled) return;
      terminalError = error;
      void terminateProcessTree(child, {
        platform: process.platform,
        force: false,
      });
      hardKillTimer = setTimeout(() => {
        void terminateProcessTree(child, {
          platform: process.platform,
          force: true,
        }).finally(() => settle(() => reject(terminalError)));
      }, REVIEWER_HARD_KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      terminateWith(Object.assign(
        new Error(`gh ${args.join(' ')} timed out after ${timeoutMs}ms`),
        { code: 'ETIMEDOUT' },
      ));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (terminalError) return;
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_GH_OUTPUT_BYTES) {
        stdout = '';
        terminateWith(Object.assign(
          new Error(`gh stdout exceeded ${MAX_GH_OUTPUT_BYTES} bytes`),
          { code: 'EOVERFLOW' },
        ));
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on('data', (d) => {
      if (terminalError) return;
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_GH_OUTPUT_BYTES) {
        stderr = '';
        terminateWith(Object.assign(
          new Error(`gh stderr exceeded ${MAX_GH_OUTPUT_BYTES} bytes`),
          { code: 'EOVERFLOW' },
        ));
        return;
      }
      stderr += stderrDecoder.write(chunk);
    });
    child.stdin.on?.('error', (err) => {
      stdinError = err;
    });
    child.on('error', (err) => {
      if (terminalError) return;
      settle(() => reject(err));
    });
    child.on('close', (code, signal) => {
      if (!terminalError) {
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      }
      if (terminalError) {
        // A detached gh child may close while a descendant still owns the
        // process group. Keep the hard-kill phase armed until it runs.
        return;
      } else if (code !== 0) {
        const diagnostic = `${stdout}\n${stderr}`;
        settle(() => reject(Object.assign(
          new Error(stderr || `gh ${args.join(' ')} exited ${signal ?? code}`),
          {
            exitCode: code,
            signal,
            stdout,
            stderr,
            status: httpStatusFromDiagnostic(diagnostic),
            ...retryMetadataFromDiagnostic(diagnostic),
          },
        )));
      } else if (stdinError) {
        settle(() => reject(
          new Error(`failed to send input to gh: ${stdinError.message}`),
        ));
      } else {
        settle(() => resolve(stdout));
      }
    });

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// All calls use spawn/execFile with an argv array (never a shell), so PR
// titles/bodies/diffs can never be interpreted as shell syntax regardless
// of their content.
async function gh(args, options = {}) {
  try {
    return await ghSpawn(args, options);
  } catch (err) {
    const detail = err.stderr || err.message;
    throw Object.assign(
      new Error(`gh ${args.join(' ')} failed: ${detail}`, { cause: err }),
      {
        code: err.code,
        exitCode: err.exitCode,
        signal: err.signal,
        status: err.status,
        stdout: err.stdout,
        stderr: err.stderr,
        retryAfterMs: err.retryAfterMs,
        rateLimitResetAtMs: err.rateLimitResetAtMs,
      },
    );
  }
}

export async function currentUsername({ auth } = {}) {
  const out = await gh(['api', 'user', '--jq', '.login'], { auth });
  return out.trim();
}

// `gh repo list` (no owner arg) only returns repos owned by the current
// user's own account. It silently excludes repos owned by orgs or other
// users where the user is merely a collaborator/org member. Using
// GET /user/repos with an explicit affiliation instead covers all three,
// paginated since accounts with many repos (1000+) exceed one page.
export async function listAccessibleRepos({ auth } = {}) {
  const out = await gh([
    'api', '--paginate', '--method', 'GET', 'user/repos',
    '-f', 'affiliation=owner,collaborator,organization_member',
    '-f', 'per_page=100',
    '--jq', '.[] | {nameWithOwner: .full_name, isPrivate: .private}',
  ], { auth });
  // --paginate with --jq emits one JSON object per line per page, not a
  // single JSON array: parse newline-delimited objects instead of one blob.
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const validatedReviewRequestSearchResults = new WeakSet();
const CANONICAL_NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const CANONICAL_POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;

function parseCanonicalSafeInteger(value, pattern) {
  if (!pattern.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function completeReviewRequestSearch(candidates) {
  for (const candidate of candidates) Object.freeze(candidate);
  Object.defineProperty(candidates, 'complete', {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  Object.freeze(candidates);
  validatedReviewRequestSearchResults.add(candidates);
  return candidates;
}

// The predicate exposes validation status without exposing any way to brand a
// caller-created array. The WeakSet itself and the marking function stay
// module-private, so cloning public properties cannot forge provenance.
export function isValidatedReviewRequestSearchResult(candidates) {
  return validatedReviewRequestSearchResults.has(candidates);
}

// Returns a bounded, pagination-validated array of { repo, number } pairs so
// every result retains the canonical repository slug returned by GitHub for
// later metadata/diff/post calls. The non-enumerable `complete` property
// preserves the existing array contract, while the module-private provenance
// above is the sole admission proof. Neither claims that concurrent changes
// produced an atomic snapshot.
export async function searchReviewRequestedPRs({ username, repo, auth }) {
  const normalizedUsername = typeof username === 'string' ? username.trim() : '';
  if (!normalizedUsername || !GITHUB_USERNAME_PATTERN.test(normalizedUsername)) {
    throw new Error('GitHub review-requested username is invalid');
  }
  const normalizedRepo = normalizeRepository(repo);
  const query = `is:pr is:open review-requested:${normalizedUsername} repo:${normalizedRepo}`;
  // --method GET is required: gh api defaults `-f` params to a POST body,
  // which 404s against /search/issues (a GET-only endpoint).
  // --paginate so a user with 100+ open PRs awaiting their review across
  // watched repos doesn't silently lose results past the first page (same
  // reasoning as listAccessibleRepos below).
  const out = await gh([
    'api', '--paginate', '--method', 'GET', '/search/issues',
    '-f', `q=${query}`, '-f', `per_page=${GITHUB_SEARCH_PAGE_SIZE}`,
    '--jq',
    '"meta|" + (.total_count | tostring) + "|" + (.incomplete_results | tostring), ' +
      '(.items[] | .repository_url + "|" + (.number | tostring))',
  ], { auth });
  const searchCandidates = [];
  let totalCount;
  let incompleteResults;
  let metadataPageCount = 0;
  const searchCandidateKeys = new Set();

  const lines = out
    .split('\n')
    .map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
    .filter((line) => line.length > 0);
  for (const line of lines) {
    if (line.startsWith('meta|')) {
      const metadataParts = line.split('|');
      if (metadataParts.length !== 3) {
        throw new Error('GitHub search returned malformed result metadata');
      }
      const [, totalCountText, incompleteResultsText] = metadataParts;
      const parsedTotalCount = parseCanonicalSafeInteger(
        totalCountText,
        CANONICAL_NONNEGATIVE_DECIMAL,
      );
      if (
        parsedTotalCount === null ||
        (incompleteResultsText !== 'true' && incompleteResultsText !== 'false')
      ) {
        throw new Error('GitHub search returned malformed result metadata');
      }
      const parsedIncompleteResults = incompleteResultsText === 'true';
      if (
        totalCount !== undefined &&
        (parsedTotalCount !== totalCount || parsedIncompleteResults !== incompleteResults)
      ) {
        throw new Error('GitHub search returned inconsistent pagination metadata');
      }
      totalCount = parsedTotalCount;
      incompleteResults = parsedIncompleteResults;
      metadataPageCount += 1;
      continue;
    }

    if (metadataPageCount === 0) {
      throw new Error('GitHub search returned a candidate without result metadata');
    }
    const candidateParts = line.split('|');
    if (candidateParts.length !== 2) {
      throw new Error('GitHub search returned a malformed pull request candidate');
    }
    const [repoUrl, numberStr] = candidateParts;
    // repository_url is like https://api.github.com/repos/OWNER/REPO
    const repoSlug = repoUrl.split('/repos/')[1];
    const number = parseCanonicalSafeInteger(
      numberStr,
      CANONICAL_POSITIVE_DECIMAL,
    );
    if (!repoSlug || number === null) {
      throw new Error('GitHub search returned a malformed pull request candidate');
    }
    if (repoSlug.toLowerCase() !== normalizedRepo.toLowerCase()) {
      throw new Error('GitHub search returned a foreign pull request candidate');
    }
    const candidateKey = `${repoSlug.toLowerCase()}#${number}`;
    if (searchCandidateKeys.has(candidateKey)) {
      throw new Error('GitHub search returned a duplicate pull request candidate');
    }
    searchCandidateKeys.add(candidateKey);
    searchCandidates.push({ repo: repoSlug, number });
  }

  if (totalCount === undefined) {
    throw new Error('GitHub search returned no result metadata');
  }

  if (totalCount > GITHUB_SEARCH_RESULT_LIMIT || incompleteResults) {
    throw new Error('GitHub search did not provide a complete result set');
  }

  const expectedMetadataPages = Math.max(
    1,
    Math.ceil(totalCount / GITHUB_SEARCH_PAGE_SIZE),
  );
  if (metadataPageCount !== expectedMetadataPages) {
    throw new Error('GitHub search returned incomplete pagination metadata');
  }
  if (searchCandidates.length !== totalCount) {
    throw new Error(
      'GitHub search candidate count did not match result metadata',
    );
  }
  return completeReviewRequestSearch(searchCandidates);
}

export async function hasActiveReviewRequest({
  repo,
  number,
  username,
  auth,
  request = gh,
}) {
  const expectedUsername = typeof username === 'string' ? username.trim() : '';
  if (
    !expectedUsername ||
    username !== expectedUsername ||
    !GITHUB_USERNAME_PATTERN.test(expectedUsername)
  ) {
    throw new Error('GitHub requested-reviewer username is invalid');
  }
  const normalizedRepo = normalizeRepository(repo);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error('GitHub requested-reviewer pull request number is invalid');
  }
  const out = await request([
    'api', '--paginate', '--method', 'GET',
    `/repos/${normalizedRepo}/pulls/${number}/requested_reviewers`,
    '-f', 'per_page=100',
    '--jq', '.users[] | {login: .login, type: .type}',
  ], { auth });
  if (
    typeof out !== 'string' ||
    Buffer.byteLength(out, 'utf8') > MAX_GH_OUTPUT_BYTES
  ) {
    throw new Error('GitHub requested reviewers response is invalid or oversized');
  }

  const lines = out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > MAX_ACTIVE_REVIEW_REQUEST_USERS) {
    throw new Error(
      `GitHub requested reviewers exceeded ${MAX_ACTIVE_REVIEW_REQUEST_USERS} users`,
    );
  }

  let active = false;
  for (const line of lines) {
    let user;
    try {
      user = JSON.parse(line);
    } catch {
      throw new Error('GitHub requested reviewers response is malformed');
    }
    const login = user?.login;
    const type = user?.type;
    const unknownField = user !== null && typeof user === 'object' && !Array.isArray(user)
      ? Object.keys(user).find((field) => !REQUESTED_REVIEWER_FIELDS.has(field))
      : undefined;
    if (
      user === null ||
      typeof user !== 'object' ||
      Array.isArray(user) ||
      unknownField !== undefined ||
      typeof login !== 'string' ||
      login !== login.trim() ||
      (
        type === 'User'
          ? !GITHUB_USERNAME_PATTERN.test(login)
          : type === 'Bot'
            ? !GITHUB_BOT_LOGIN_PATTERN.test(login)
            : true
      )
    ) {
      throw new Error('GitHub requested reviewers response is malformed');
    }
    if (
      type === 'User' &&
      login.toLowerCase() === expectedUsername.toLowerCase()
    ) active = true;
  }
  return active;
}

export async function getPullRequest({ repo, number, auth, timeoutMs }) {
  const out = await gh([
    'pr', 'view', String(number),
    '--repo', repo,
    '--json', 'headRefOid,number,title,url,body,baseRefName,headRefName,state',
  ], { auth, timeoutMs });
  return JSON.parse(out);
}

export async function getPullRequestDiff({ repo, number, auth }) {
  return gh(['pr', 'diff', String(number), '--repo', repo], { auth });
}

// Parses a unified diff into a set of "path:line" strings that are actually
// addressable as RIGHT-side review comments (i.e. added/context lines within
// a hunk). GitHub 422s a whole review if any comment's line isn't part of
// the diff, so findings must be checked against this before being sent as
// inline comments rather than discovered via a failed API call.
export function diffAnchors(diffText) {
  const anchors = new Set();
  let currentPath = null;
  let rightLine = null;
  let remainingOldLines = null;
  let remainingNewLines = null;
  let anchorChars = 0;

  // Iterate over lines without first materializing an array containing every
  // line in the diff. A review can receive a large, valid diff, and the
  // anchors themselves are separately bounded below.
  for (let offset = 0; offset < diffText.length;) {
    const newline = diffText.indexOf('\n', offset);
    const lineEnd = newline === -1 ? diffText.length : newline;
    const rawLine = diffText.slice(offset, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const hunkMatch = line.match(
      /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
    );
    if (hunkMatch) {
      remainingOldLines = Number(hunkMatch[1] ?? 1);
      remainingNewLines = Number(hunkMatch[3] ?? 1);
      rightLine = Number(hunkMatch[2]);
    } else if (remainingOldLines === null && remainingNewLines === null) {
      const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
      if (fileMatch) currentPath = fileMatch[1];
    } else if (currentPath !== null) {
      const isRightSideLine = line.startsWith('+') || line.startsWith(' ');
      if (isRightSideLine) {
        const lineNumber = String(rightLine);
        const nextAnchorChars = currentPath.length + 1 + lineNumber.length;
        if (
          anchors.size >= MAX_DIFF_ANCHORS ||
          anchorChars + nextAnchorChars > MAX_DIFF_ANCHOR_CHARS
        ) {
          // A partial set could incorrectly classify a finding as
          // anchorable. Returning an empty set preserves the invariant that
          // every inline comment has been validated against the full diff.
          return new Set();
        }
        anchors.add(`${currentPath}:${lineNumber}`);
        anchorChars += nextAnchorChars;
        rightLine += 1;
        remainingNewLines -= 1;
        if (line.startsWith(' ')) remainingOldLines -= 1;
      } else if (line.startsWith('-')) {
        // Removed line: doesn't advance the right-side line counter.
        remainingOldLines -= 1;
      }
      if (remainingOldLines === 0 && remainingNewLines === 0) {
        remainingOldLines = null;
        remainingNewLines = null;
      }
    }

    if (newline === -1) break;
    offset = newline + 1;
  }

  return anchors;
}

function formatComment(c) {
  return `**[${c.severity}]** ${c.comment}`;
}

function formatAttribution(auth) {
  const username = auth?.username?.trim();
  if (!username) {
    throw new Error('review attribution requires the authenticated reviewer username');
  }
  return `🤖 **AI-generated review:** OpenMergeLens generated this review on behalf of @${username}. Verify findings before acting.`;
}

function formatFindingLocation(c) {
  const safePath = c.path
    .replace(/[\r\n\u0000]/g, '\uFFFD')
    .replaceAll('`', '\\`');
  return `\`${safePath}:${c.line}\``;
}

function validateReviewForPosting(body, comments) {
  if (typeof body !== 'string' || body.length > MAX_REVIEW_SUMMARY_CHARS) {
    throw new Error(`review summary exceeds ${MAX_REVIEW_SUMMARY_CHARS} characters`);
  }
  if (!Array.isArray(comments) || comments.length > MAX_REVIEW_FINDINGS) {
    throw new Error(`review exceeds ${MAX_REVIEW_FINDINGS} findings`);
  }
  for (const comment of comments) {
    if (
      !comment ||
      typeof comment.path !== 'string' ||
      !comment.path ||
      comment.path.length > MAX_REVIEW_PATH_CHARS ||
      /[\r\n\u0000]/.test(comment.path) ||
      !Number.isSafeInteger(comment.line) ||
      comment.line < 1 ||
      !['critical', 'major', 'nit'].includes(comment.severity) ||
      typeof comment.comment !== 'string' ||
      !comment.comment ||
      comment.comment.length > MAX_REVIEW_COMMENT_CHARS
    ) {
      throw new Error('review contains an invalid or unsafe finding');
    }
  }
}

export function createReviewMarker({ account, repo, number, commitId }) {
  const identity = JSON.stringify([
    account.hostname.toLowerCase(),
    account.username.toLowerCase(),
    repo.toLowerCase(),
    Number(number),
    commitId,
  ]);
  const digest = createHash('sha256').update(identity).digest('hex');
  return `<!-- openmergelens-review:${digest} -->`;
}

function parseJsonLines(output) {
  if (
    typeof output !== 'string' ||
    Buffer.byteLength(output, 'utf8') > MAX_GH_OUTPUT_BYTES
  ) {
    throw new Error('GitHub review reconciliation response is invalid or oversized');
  }
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > MAX_GITHUB_REVIEWS_FOR_RECONCILIATION) {
    throw new Error(
      `GitHub review reconciliation exceeded ${MAX_GITHUB_REVIEWS_FOR_RECONCILIATION} reviews`,
    );
  }
  return lines.map((line) => JSON.parse(line));
}

export async function reviewAlreadyPosted({
  repo,
  number,
  commitId,
  marker,
  auth,
  request = gh,
}) {
  const expectedReviewer = auth?.username?.trim().toLowerCase();
  if (!expectedReviewer) {
    throw new Error('review reconciliation requires the authenticated reviewer username');
  }
  const out = await request([
    'api',
    '--paginate',
    '--method',
    'GET',
    `/repos/${repo}/pulls/${number}/reviews`,
    '-f',
    'per_page=100',
    '--jq',
    '.[] | {body, commit_id, state, user_login: .user.login}',
  ], { auth });
  let matched = false;
  for (const review of parseJsonLines(out)) {
    const unknownField = review !== null &&
      typeof review === 'object' &&
      !Array.isArray(review)
      ? Object.keys(review).find((field) => !RECONCILIATION_REVIEW_FIELDS.has(field))
      : undefined;
    const login = review?.user_login;
    if (
      review === null ||
      typeof review !== 'object' ||
      Array.isArray(review) ||
      unknownField !== undefined ||
      (review.body !== null && typeof review.body !== 'string') ||
      (review.commit_id !== null && typeof review.commit_id !== 'string') ||
      typeof review.state !== 'string' ||
      !GITHUB_REVIEW_STATES.has(review.state) ||
      (login !== null && typeof login !== 'string') ||
      (
        login !== null &&
        (
          login !== login.trim() ||
          (
            !GITHUB_USERNAME_PATTERN.test(login) &&
            !GITHUB_BOT_LOGIN_PATTERN.test(login)
          )
        )
      )
    ) {
      throw new Error('GitHub review reconciliation response is malformed');
    }
    if (
      review.state !== 'PENDING' &&
      typeof review.commit_id === 'string' &&
      review.commit_id.length > 0 &&
      review.commit_id === commitId &&
      typeof login === 'string' &&
      login.length > 0 &&
      login.toLowerCase() === expectedReviewer &&
      review.body?.includes(marker)
    ) matched = true;
  }
  return matched;
}

const RECONCILIATION_ERROR_METADATA = [
  'code',
  'exitCode',
  'status',
  'stdout',
  'stderr',
  'retryAfterMs',
  'rateLimitResetAtMs',
];

function copyErrorMetadata(error) {
  return Object.fromEntries(
    RECONCILIATION_ERROR_METADATA
      .filter((key) => error?.[key] !== undefined)
      .map((key) => [key, error[key]]),
  );
}

async function reconcileSubmittedReview(options, originalError) {
  const { scheduleMutation, ...reviewOptions } = options;
  try {
    // Reconciliation is a GitHub request too. It must use the same scheduler
    // so a rate-limited GET updates the queue's backoff before the next write.
    return await scheduleMutation(
      () => reviewAlreadyPosted(reviewOptions),
      { mutation: false },
    );
  } catch (reconciliationError) {
    // Preserve boundary decisions for the poller instead of hiding them in a
    // generic reconciliation failure.
    if (mutationBoundaryReason(reconciliationError)) throw reconciliationError;
    const wrappedError = new Error(
      `${originalError.message}; could not reconcile the review: ${reconciliationError.message}`,
      { cause: reconciliationError },
    );
    Object.assign(wrappedError, {
      ...copyErrorMetadata(reconciliationError),
      originalError,
    });
    throw wrappedError;
  }
}

// Uses `gh api` (not `gh pr review`) because the CLI subcommand has no way to
// attach per-line comments: only the REST API's `comments[]` array does.
//
// Findings are split into anchorable (path:line present in the diff) and
// unanchorable before ever calling the API, since GitHub rejects the entire
// review if a single comment's line isn't part of the diff: one bad/
// hallucinated line number must not lose the whole review. Unanchorable
// findings are folded into the body instead of dropped. As a last-resort
// safety net (e.g. a line technically in the diff but rejected for some
// other reason), a 422 on the full request is retried once with every
// comment demoted into the body, so posting only fails if that also fails.
export function prepareReview({
  commitId,
  body,
  comments,
  diff,
  marker,
  event = 'COMMENT',
  auth,
}) {
  if (!marker) throw new Error('review marker is required');
  validateReviewForPosting(body, comments);

  const anchors = diffAnchors(diff);
  const anchorable = [];
  const unanchorable = [];

  for (const c of comments) {
    if (anchors.has(`${c.path}:${c.line}`)) {
      anchorable.push(c);
    } else {
      unanchorable.push(c);
    }
  }

  const extraBody = unanchorable.length
    ? '\n\n---\n**Additional findings (could not anchor to a diff line):**\n' +
      unanchorable.map((c) => `- ${formatFindingLocation(c)} ${formatComment(c)}`).join('\n')
    : '';
  const attribution = formatAttribution(auth);
  const reviewBody = `${body}${extraBody}\n\n---\n${attribution}\n\n${marker}`;
  if (reviewBody.length > MAX_GITHUB_REVIEW_BODY_CHARS) {
    throw new Error(
      `review body exceeds ${MAX_GITHUB_REVIEW_BODY_CHARS} characters`,
    );
  }

  return {
    anchorable,
    unanchorable,
    attribution,
    reviewBody,
    payload: {
      commit_id: commitId,
      event,
      body: reviewBody,
      comments: anchorable.map((c) => ({
        path: c.path,
        line: c.line,
        side: 'RIGHT',
        body: formatComment(c),
      })),
    },
  };
}

export async function postReview({
  repo,
  number,
  commitId,
  body,
  comments,
  diff,
  marker,
  event = 'COMMENT',
  auth,
  request = gh,
  scheduleMutation,
}) {
  if (!marker) throw new Error('review marker is required');
  if (typeof scheduleMutation !== 'function') {
    throw new Error('review posting requires a GitHub mutation scheduler');
  }
  const prepared = prepareReview({
    commitId,
    body,
    comments,
    diff,
    marker,
    event,
    auth,
  });

  try {
    await scheduleMutation(
      () => request(
        [
          'api', '--include', '--method', 'POST',
          `/repos/${repo}/pulls/${number}/reviews`, '--input', '-',
        ],
        { input: JSON.stringify(prepared.payload), auth },
      ),
      { mutation: true },
    );
  } catch (err) {
    // Mutation-boundary sentinels are definitive local decisions, not
    // ambiguous transport failures. Let the poller classify them before any
    // reconciliation or validation fallback can turn them into success.
    if (mutationBoundaryReason(err)) throw err;
    // A rate-limited mutation is definitively rejected. Do not issue even a
    // reconciliation GET while GitHub has told this integration to pause.
    if (isGitHubRateLimitError(err)) throw err;
    const reconciliationOptions = {
      repo,
      number,
      commitId,
      marker,
      auth,
      request,
      scheduleMutation,
    };
    if (await reconcileSubmittedReview(reconciliationOptions, err)) return;
    if (err.status !== 422 || prepared.anchorable.length === 0) throw err;

    // Last-resort fallback: fold every comment into the body and retry once,
    // so a single unexpected rejection doesn't lose the whole review.
    const fallbackBody = body +
      '\n\n---\n**All findings (inline comments rejected by GitHub):**\n' +
      comments.map((c) => `- ${formatFindingLocation(c)} ${formatComment(c)}`).join('\n') +
      `\n\n---\n${prepared.attribution}\n\n${marker}`;
    if (fallbackBody.length > MAX_GITHUB_REVIEW_BODY_CHARS) {
      throw new Error(
        `fallback review body exceeds ${MAX_GITHUB_REVIEW_BODY_CHARS} characters`,
      );
    }
    try {
      await scheduleMutation(
        () => request(
          [
            'api', '--include', '--method', 'POST',
            `/repos/${repo}/pulls/${number}/reviews`, '--input', '-',
          ],
          {
            input: JSON.stringify({
              commit_id: commitId,
              event,
              body: fallbackBody,
              comments: [],
            }),
            auth,
          },
        ),
        { mutation: true },
      );
    } catch (fallbackError) {
      if (mutationBoundaryReason(fallbackError)) throw fallbackError;
      if (isGitHubRateLimitError(fallbackError)) throw fallbackError;
      if (await reconcileSubmittedReview(reconciliationOptions, fallbackError)) return;
      throw fallbackError;
    }
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeGitHubAccount } from './config.mjs';

const execFileAsync = promisify(execFile);
const GH_AUTH_TIMEOUT_MS = 60_000;

// gh 2.80 does not expose JSON output for `gh auth status`, so parse only the
// stable account and active-account lines. Token and scope lines are ignored.
export function parseAuthStatus(output) {
  const accounts = [];
  let current = null;

  for (const line of output.split('\n')) {
    const accountMatch = line.match(
      /^\s*(?:[✓✔]\s+)?Logged in to (\S+) account (\S+)(?:\s|$)/,
    );
    if (accountMatch) {
      current = {
        hostname: accountMatch[1].toLowerCase(),
        username: accountMatch[2],
        active: false,
      };
      accounts.push(current);
      continue;
    }

    if (current && /^\s*-\s*Active account:\s*true\s*$/.test(line)) {
      current.active = true;
    }
  }

  return accounts;
}

export async function listAuthenticatedAccounts() {
  let output = '';
  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'], {
      timeout: GH_AUTH_TIMEOUT_MS,
      env: { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' },
    });
    output = `${stdout}\n${stderr}`;
  } catch (err) {
    // `gh auth status` exits non-zero when any stored account is invalid, but
    // still prints valid accounts. Offer those rather than failing setup.
    output = `${err.stdout || ''}\n${err.stderr || ''}`;
    const validAccounts = parseAuthStatus(output);
    if (validAccounts.length > 0) return validAccounts;
    throw new Error('GitHub CLI has no authenticated accounts; run `gh auth login`');
  }

  return parseAuthStatus(output);
}

export async function resolveGitHubAuth(account, { timeoutMs = GH_AUTH_TIMEOUT_MS } = {}) {
  const normalized = normalizeGitHubAccount(account);
  let stdout;

  try {
    ({ stdout } = await execFileAsync(
      'gh',
      [
        'auth', 'token',
        '--hostname', normalized.hostname,
        '--user', normalized.username,
      ],
      {
        timeout: timeoutMs,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      },
    ));
  } catch {
    throw new Error(
      `GitHub CLI has no usable authentication for ${normalized.username} on ` +
      `${normalized.hostname}; run \`gh auth login --hostname ${normalized.hostname}\``,
    );
  }

  const token = stdout.trim();
  if (!token) {
    throw new Error(
      `GitHub CLI returned an empty token for ${normalized.username} on ${normalized.hostname}`,
    );
  }

  return { ...normalized, token };
}

export function authEnvironment(auth, baseEnvironment = process.env) {
  if (!auth?.token) return { ...baseEnvironment };

  const { hostname, username } = normalizeGitHubAccount(auth);
  const environment = {
    ...baseEnvironment,
    GH_HOST: hostname,
    GH_PROMPT_DISABLED: '1',
  };

  // Ensure ambient credentials can never override the account selected in
  // init. GitHub.com and ghe.com use GH_TOKEN; GHES uses GH_ENTERPRISE_TOKEN.
  delete environment.GH_TOKEN;
  delete environment.GITHUB_TOKEN;
  delete environment.GH_ENTERPRISE_TOKEN;
  delete environment.GITHUB_ENTERPRISE_TOKEN;

  if (hostname === 'github.com' || hostname.endsWith('.ghe.com')) {
    environment.GH_TOKEN = auth.token;
  } else {
    environment.GH_ENTERPRISE_TOKEN = auth.token;
  }

  // Useful to callers for diagnostics without ever exposing the token.
  environment.OPENMERGELENS_GITHUB_ACCOUNT = `${username}@${hostname}`;
  return environment;
}

import { spawn } from 'node:child_process';
import { normalizeGitHubAccount } from './config.mjs';
import { terminateProcessTree } from './process-launch.mjs';

const GH_AUTH_TIMEOUT_MS = 60_000;
const GH_AUTH_HARD_KILL_GRACE_MS = 250;
const MAX_AUTH_OUTPUT_BYTES = 1024 * 1024;

export function runGitHubAuthCommand(
  command,
  args,
  {
    timeoutMs,
    environment,
    platform = process.platform,
    spawnProcess = spawn,
    terminate = terminateProcessTree,
    hardKillGraceMs = GH_AUTH_HARD_KILL_GRACE_MS,
  },
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        env: environment,
        shell: false,
        windowsHide: true,
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let awaitingWindowsTreeKill = false;
    let timeoutHandle;
    let hardKillHandle;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      // Once the timeout fires, retain the hard-kill timer even if the leader
      // exits after SIGTERM. A descendant may ignore SIGTERM and keep the
      // detached process group alive after the leader's close event.
      if (!timedOut) clearTimeout(hardKillHandle);
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(result);
      }
    };
    const appendBounded = (current, chunk) => {
      if (Buffer.byteLength(current, 'utf8') >= MAX_AUTH_OUTPUT_BYTES) return current;
      return (current + chunk.toString('utf8')).slice(0, MAX_AUTH_OUTPUT_BYTES);
    };
    child.stdout?.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once('error', (err) => {
      if (!awaitingWindowsTreeKill) finish(err);
    });
    child.once('close', (code, signal) => {
      if (awaitingWindowsTreeKill) return;
      if (timedOut) {
        finish(Object.assign(
          new Error(`${command} timed out after ${timeoutMs}ms`),
          { code: 'ETIMEDOUT', signal },
        ));
      } else if (code !== 0) {
        finish(Object.assign(
          new Error(`${command} exited with status ${code ?? signal}`),
          { code, signal },
        ));
      } else {
        finish(null, { stdout, stderr });
      }
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (platform === 'win32') {
        // taskkill can discover descendants only while the leader PID still
        // identifies the tree. Start the forced tree stop before a graceful
        // child.kill() can let that leader exit and orphan its descendants.
        awaitingWindowsTreeKill = true;
        let termination;
        try {
          termination = terminate(child, { platform, force: true });
        } catch (cause) {
          finish(Object.assign(
            new Error(
              `${command} timed out and its process tree could not be terminated`,
              { cause },
            ),
            { code: 'ETERMINATE', timeoutCode: 'ETIMEDOUT' },
          ));
          return;
        }
        void Promise.resolve(termination).then(
          () => finish(Object.assign(
            new Error(`${command} timed out after ${timeoutMs}ms`),
            { code: 'ETIMEDOUT', signal: 'SIGKILL' },
          )),
          (cause) => finish(Object.assign(
            new Error(
              `${command} timed out and its process tree could not be terminated`,
              { cause },
            ),
            { code: 'ETERMINATE', timeoutCode: 'ETIMEDOUT' },
          )),
        );
        return;
      }
      void terminate(child, { platform, force: false }).catch(() => {});
      hardKillHandle = setTimeout(() => {
        void terminate(child, { platform, force: true }).finally(() => {
          // Never wait indefinitely for a child that ignores SIGTERM or fails
          // to emit close after a hard tree kill.
          finish(Object.assign(
            new Error(`${command} timed out after ${timeoutMs}ms`),
            { code: 'ETIMEDOUT', signal: 'SIGKILL' },
          ));
        });
      }, hardKillGraceMs);
    }, timeoutMs);
  });
}

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
    const { stdout, stderr } = await runGitHubAuthCommand('gh', ['auth', 'status'], {
      timeoutMs: GH_AUTH_TIMEOUT_MS,
      environment: { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' },
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
    ({ stdout } = await runGitHubAuthCommand(
      'gh',
      [
        'auth', 'token',
        '--hostname', normalized.hostname,
        '--user', normalized.username,
      ],
      {
        timeoutMs,
        environment: { ...process.env, GH_PROMPT_DISABLED: '1' },
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

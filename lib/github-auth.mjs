import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
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
    // Count the bytes received from the child, rather than re-encoding the
    // decoded string. A stream chunk may split a UTF-8 sequence, in which
    // case decoding each chunk independently can inflate the apparent byte
    // length with replacement characters and reject an in-bounds response.
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let settled = false;
    let timedOut = false;
    let awaitingTreeKill = false;
    let outputOverflowed = false;
    let timeoutHandle;
    let hardKillHandle;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      // Once the timeout fires, retain the hard-kill timer even if the leader
      // exits after SIGTERM. A descendant may ignore SIGTERM and keep the
      // detached process group alive after the leader's close event.
      if (!timedOut) clearTimeout(hardKillHandle);
      // Flush a complete UTF-8 sequence that may have been held across data
      // events. Overflow intentionally discards all captured output so a
      // hostile command cannot retain or expose a bounded-but-sensitive
      // prefix while forced tree termination is being reported.
      if (outputOverflowed) {
        stdout = '';
        stderr = '';
      } else {
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      }
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    };
    const appendBounded = (streamName, chunk) => {
      const byteCount = streamName === 'stdout' ? stdoutBytes : stderrBytes;
      const next = byteCount + chunk.byteLength;
      if (next > MAX_AUTH_OUTPUT_BYTES) {
        throw Object.assign(
          new Error(`${command} ${streamName} exceeded ${MAX_AUTH_OUTPUT_BYTES} bytes`),
          { code: 'EOVERFLOW' },
        );
      }
      if (streamName === 'stdout') {
        stdoutBytes = next;
        stdout += stdoutDecoder.write(chunk);
      } else {
        stderrBytes = next;
        stderr += stderrDecoder.write(chunk);
      }
    };
    const onOutput = (streamName, chunk) => {
      if (settled || outputOverflowed) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      try {
        appendBounded(streamName, bytes);
      } catch (err) {
        outputOverflowed = true;
        // Stop accepting output immediately, then wait for a forced process
        // tree termination before settling. The child may have descendants
        // that survive its leader, so resolving/rejecting first would allow
        // unbounded post-return output and leaked work to continue.
        awaitingTreeKill = true;
        let termination;
        try {
          termination = terminate(child, { platform, force: true });
        } catch (cause) {
          finish(Object.assign(
            new Error(`${command} output overflow and its process tree could not be terminated`, { cause }),
            { code: 'ETERMINATE', overflowCode: err.code },
          ));
          return;
        }
        void Promise.resolve(termination).then(
          () => finish(err),
          (cause) => finish(Object.assign(
            new Error(`${command} output overflow and its process tree could not be terminated`, { cause }),
            { code: 'ETERMINATE', overflowCode: err.code },
          )),
        );
      }
    };
    child.stdout?.on('data', (chunk) => {
      onOutput('stdout', chunk);
    });
    child.stderr?.on('data', (chunk) => {
      onOutput('stderr', chunk);
    });
    child.once('error', (err) => {
      if (!awaitingTreeKill) finish(err);
    });
    child.once('close', (code, signal) => {
      if (awaitingTreeKill) return;
      if (timedOut) {
        finish(Object.assign(
          new Error(`${command} timed out after ${timeoutMs}ms`),
          { code: 'ETIMEDOUT', signal },
        ));
      } else if (code !== 0) {
        finish(Object.assign(
          new Error(`${command} exited with status ${code ?? signal}`),
          { code, signal, completedExit: true },
        ));
      } else {
        finish(null);
      }
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (platform === 'win32') {
        // taskkill can discover descendants only while the leader PID still
        // identifies the tree. Start the forced tree stop before a graceful
        // child.kill() can let that leader exit and orphan its descendants.
        awaitingTreeKill = true;
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

export async function listAuthenticatedAccounts({
  runCommand = runGitHubAuthCommand,
} = {}) {
  let output = '';
  try {
    const { stdout, stderr } = await runCommand('gh', ['auth', 'status'], {
      timeoutMs: GH_AUTH_TIMEOUT_MS,
      environment: { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' },
    });
    output = `${stdout}\n${stderr}`;
  } catch (err) {
    // `gh auth status` exits non-zero when any stored account is invalid, but
    // still prints valid accounts. Salvage those only after a completed,
    // expected non-zero exit. Timeouts, launch failures, output overflow, and
    // unconfirmed process-tree termination can contain partial untrusted bytes
    // and must propagate unchanged.
    if (
      err.completedExit !== true ||
      !Number.isInteger(err.code) ||
      err.code <= 0 ||
      err.signal != null
    ) {
      throw err;
    }
    output = `${err.stdout || ''}\n${err.stderr || ''}`;
    const validAccounts = parseAuthStatus(output);
    if (validAccounts.length > 0) return validAccounts;
    throw new Error('GitHub CLI has no authenticated accounts; run `gh auth login`');
  }

  return parseAuthStatus(output);
}

function sanitizedAuthCommandFailure(normalized, err) {
  const safeCode = typeof err?.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(err.code)
    ? err.code
    : 'EUNKNOWN';
  const safeTimeoutCode = typeof err?.timeoutCode === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(err.timeoutCode)
    ? err.timeoutCode
    : undefined;
  const cause = Object.assign(
    new Error(`GitHub CLI authentication command failed abnormally (${safeCode})`),
    { code: safeCode },
  );
  if (safeTimeoutCode !== undefined) cause.timeoutCode = safeTimeoutCode;
  return Object.assign(
    new Error(
      `GitHub CLI authentication command failed abnormally for ` +
      `${normalized.username} on ${normalized.hostname}`,
      { cause },
    ),
    {
      code: 'EGITHUBAUTHCOMMAND',
      failureCode: safeCode,
    },
  );
}

export async function resolveGitHubAuth(
  account,
  {
    timeoutMs = GH_AUTH_TIMEOUT_MS,
    runCommand = runGitHubAuthCommand,
  } = {},
) {
  const normalized = normalizeGitHubAccount(account);
  let stdout;

  try {
    ({ stdout } = await runCommand(
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
  } catch (err) {
    if (
      err?.completedExit !== true ||
      !Number.isInteger(err.code) ||
      err.code <= 0 ||
      err.signal != null
    ) {
      throw sanitizedAuthCommandFailure(normalized, err);
    }
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

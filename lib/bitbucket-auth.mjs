import { spawn } from 'node:child_process';

const CREDENTIAL_TIMEOUT_MS = 10_000;
const MAX_CREDENTIAL_OUTPUT_BYTES = 64 * 1024;
const BITBUCKET_ACCOUNT_ID_PATTERN = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/iu;

export function normalizeBitbucketCredentialUsername(value) {
  if (typeof value !== 'string') {
    throw new Error('Bitbucket credential username is invalid');
  }
  const username = value.trim();
  if (!username || username.length > 254 || /[\0\r\n]/u.test(username)) {
    throw new Error('Bitbucket credential username is invalid');
  }
  return username;
}

function runCredentialFill({ input, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['credential', 'fill'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    let killAttempted = false;
    const killChild = () => {
      if (killAttempted) return;
      killAttempted = true;
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        // The process may already have closed. The original bounded lookup
        // failure remains the useful error and must not expose helper output.
      }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const fail = (message, { kill = true } = {}) => {
      // Keep every error listener installed for the lifetime of its emitter,
      // but let only the first failure settle and terminate the helper.
      if (settled) return;
      if (kill) killChild();
      finish(new Error(message));
    };
    const timer = setTimeout(() => {
      fail('Bitbucket credential lookup timed out');
    }, CREDENTIAL_TIMEOUT_MS);
    child.on('error', () => fail('could not start git credential lookup', { kill: false }));
    // git credential helpers can close stdin before consuming the request.
    // Keep this listener installed for the stream lifetime so a late EPIPE
    // cannot become an unhandled process error after another event settles
    // the lookup promise.
    child.stdin.on('error', () => {
      fail('could not send request to git credential lookup');
    });
    child.stdout.on('error', () => {
      fail('could not read response from git credential lookup');
    });
    child.stderr.on('error', () => {
      fail('could not read diagnostics from git credential lookup');
    });
    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > MAX_CREDENTIAL_OUTPUT_BYTES) {
        fail('Bitbucket credential lookup returned too much data');
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_CREDENTIAL_OUTPUT_BYTES) {
        fail('Bitbucket credential lookup returned too much data');
      }
    });
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error('git credential lookup did not return a Bitbucket credential'));
        return;
      }
      finish(null, stdout.toString('utf8'));
    });
    try {
      child.stdin.end(input);
    } catch {
      fail('could not send request to git credential lookup');
    }
  });
}

function parseCredential(output, expectedUsername) {
  const fields = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const username = fields.get('username');
  const password = fields.get('password');
  if (username !== expectedUsername || !password || /[\0\r\n]/u.test(password)) {
    throw new Error('git credential lookup returned an unusable Bitbucket credential');
  }
  return { username, password };
}

export async function resolveBitbucketAuth(
  account,
  { credentialFill = runCredentialFill, requestUser } = {},
) {
  const discovered = await discoverBitbucketAccount(account.credentialUsername, {
    credentialFill,
    requestUser,
  });
  if (discovered.account.accountId.toLowerCase() !== account.accountId.toLowerCase()) {
    throw new Error('Bitbucket credential belongs to a different account UUID');
  }
  return { ...discovered.auth, accountId: account.accountId };
}

export async function discoverBitbucketAccount(
  credentialUsername,
  { credentialFill = runCredentialFill, requestUser } = {},
) {
  const normalizedUsername = normalizeBitbucketCredentialUsername(credentialUsername);
  const output = await credentialFill({
    input: `protocol=https\nhost=bitbucket.org\nusername=${normalizedUsername}\n\n`,
  });
  const credential = parseCredential(output, normalizedUsername);
  const auth = {
    hostname: 'bitbucket.org',
    username: credential.username,
    password: credential.password,
  };
  if (typeof requestUser !== 'function') {
    throw new Error('Bitbucket identity verification is unavailable');
  }
  const user = await requestUser({ auth });
  const accountId = typeof user?.uuid === 'string' ? user.uuid.trim().toLowerCase() : '';
  if (!BITBUCKET_ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error('Bitbucket identity response did not contain a valid account UUID');
  }
  auth.accountId = accountId;
  auth.displayName = user.display_name || user.nickname || credential.username;
  return {
    account: {
      hostname: 'bitbucket.org',
      accountId,
      credentialUsername: normalizedUsername,
    },
    auth,
  };
}

export const __test = { parseCredential, runCredentialFill };

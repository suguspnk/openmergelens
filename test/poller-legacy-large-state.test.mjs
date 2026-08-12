import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAiProcessingConsent } from '../lib/ai-processing-consent.mjs';
import { pollOnce } from '../lib/poller.mjs';
import { MAX_STATE_FILE_BYTES } from '../lib/security-limits.mjs';
import { prKey, serializeState } from '../lib/state.mjs';

const validatedSearchResults = new WeakSet();

function completeSearch(candidates) {
  validatedSearchResults.add(candidates);
  return candidates;
}

test('near-32-MiB compact predecessor persists byte-neutral repair progress', {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmergelens-state-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const account = {
    hostname: 'github.com',
    username: 'a',
    repositories: ['o/a'],
  };
  const entryCount = 300_000;
  const state = Object.fromEntries(
    Array.from({ length: entryCount }, (_, index) => [
      prKey('o/a', index + 1, account),
      {
        lastReviewedSha: 's',
        lastReviewedAt: '2026-08-11T00:00:00.000Z',
      },
    ]),
  );
  const compact = JSON.stringify(state);
  assert.ok(Buffer.byteLength(compact) < MAX_STATE_FILE_BYTES * 2);
  assert.ok(
    serializeState(state, {
      enforceEntryLimit: false,
      enforceByteLimit: false,
    }).serializedBytes > MAX_STATE_FILE_BYTES * 2,
  );
  await writeFile(stateFile, compact);
  const checked = [];
  const dependencies = {
    createGitHubMutationQueue: () => ({
      run: async (operation) => operation(),
    }),
    createGitHubMutationCadence: () => ({
      run: async (operation, { beforeStart } = {}) => {
        if (beforeStart) await beforeStart();
        return operation();
      },
    }),
    resolveGitHubAuth: async (candidateAccount) => ({
      username: candidateAccount.username,
    }),
    currentUsername: async ({ auth }) => auth.username,
    isValidatedReviewRequestSearchResult: (candidates) =>
      validatedSearchResults.has(candidates),
    searchReviewRequestedPRs: async () => completeSearch([]),
    getPullRequestForStateGc: async ({ repo, number }) => {
      checked.push(number);
      return {
        headRefOid: 's',
        number,
        title: 'Tracked PR',
        url: `https://github.com/${repo}/pull/${number}`,
        body: '',
        state: 'OPEN',
      };
    },
    now: () => Date.parse('2026-08-12T00:00:00.000Z'),
  };
  const config = {
    configVersion: 5,
    githubAccounts: [account],
    aiProcessingConsent: createAiProcessingConsent('reviewer', [account]),
    reviewerCommand: 'reviewer',
    model: null,
    reviewerInputMode: 'stdin',
    reviewBatchSize: 1,
    reviewFocusCount: 1,
    stateFile: './state.json',
  };
  const options = {
    config,
    stateFile,
    logPath: path.join(root, 'poll.log'),
    defaultReviewPromptPath: path.join(root, 'template.md'),
    logger: {
      child() { return this; },
      info() {},
      warn() {},
      error() {},
      output() {},
    },
    dependencies,
  };

  const first = await pollOnce(options);
  assert.equal(first.failed, true);
  assert.equal(checked.length, 1_000);
  const firstPersisted = await readFile(stateFile, 'utf8');
  assert.ok(Buffer.byteLength(firstPersisted) < MAX_STATE_FILE_BYTES * 2);
  assert.equal(firstPersisted.includes('\n  "'), false);

  const second = await pollOnce(options);
  assert.equal(second.failed, true);
  assert.equal(checked.length, 2_000);
  assert.equal(checked[1_000], 1_001);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  roundRobinAccountQueues,
  selectConfiguredAccounts,
} from '../lib/poll-queue.mjs';

const work = { hostname: 'github.com', username: 'work' };
const personal = { hostname: 'github.com', username: 'personal' };

test('review queues are interleaved fairly without losing account context', () => {
  assert.deepEqual(
    roundRobinAccountQueues([
      { account: work, items: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] },
      { account: personal, items: [{ id: 'p1' }] },
    ]).map(({ account, id }) => `${account.username}:${id}`),
    ['work:w1', 'personal:p1', 'work:w2', 'work:w3'],
  );
});

test('account queues stay fair while preserving each account order', () => {
  assert.deepEqual(
    roundRobinAccountQueues([
      {
        account: work,
        items: [
          { id: 'w-requested-1' },
          { id: 'w-requested-2' },
          { id: 'w-requested-3' },
        ],
      },
      {
        account: personal,
        items: [
          { id: 'p-requested-1' },
          { id: 'p-requested-2' },
        ],
      },
    ]).map(({ account, id }) => `${account.username}:${id}`),
    [
      'work:w-requested-1',
      'personal:p-requested-1',
      'work:w-requested-2',
      'personal:p-requested-2',
      'work:w-requested-3',
    ],
  );
});

test('repository queues are interleaved within an account while preserving repository order', () => {
  assert.deepEqual(
    roundRobinAccountQueues([
      {
        account: work,
        items: [
          { repo: 'owner/busy', id: 'busy-requested-1' },
          { repo: 'owner/busy', id: 'busy-requested-2' },
          { repo: 'owner/busy', id: 'busy-requested-3' },
          { repo: 'owner/starved', id: 'starved-requested-1' },
          { repo: 'owner/starved', id: 'starved-requested-2' },
        ],
      },
    ]).map(({ account, id }) => `${account.username}:${id}`),
    [
      'work:busy-requested-1',
      'work:starved-requested-1',
      'work:busy-requested-2',
      'work:starved-requested-2',
      'work:busy-requested-3',
    ],
  );
});

test('an account selector is host-aware and rejects unknown accounts', () => {
  const accounts = [work, { hostname: 'enterprise.example.com', username: 'work' }];
  assert.deepEqual(
    selectConfiguredAccounts(accounts, { hostname: 'github.com', username: 'WORK' }),
    [work],
  );
  assert.throws(
    () => selectConfiguredAccounts(accounts, personal),
    /is not configured/,
  );
});

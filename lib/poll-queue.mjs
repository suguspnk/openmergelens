import { accountLabel } from './config.mjs';

function prioritizeRequestedCandidates(items) {
  const requested = [];
  const tracked = [];

  for (const item of items) {
    if (item.source === 'requested') requested.push(item);
    else tracked.push(item);
  }

  return [...requested, ...tracked];
}

function repositoryQueueKey(item) {
  return typeof item.repo === 'string' ? item.repo.toLowerCase() : '';
}

function roundRobinQueues(queues) {
  const result = [];
  let remaining = queues.reduce((total, queue) => total + queue.items.length, 0);

  while (remaining > 0) {
    for (const queue of queues) {
      const item = queue.items.shift();
      if (item === undefined) continue;
      result.push({ queue, item });
      remaining -= 1;
    }
  }
  return result;
}

function interleaveRepositoryQueues(items) {
  const queues = [];
  const queuesByRepository = new Map();

  for (const item of items) {
    const key = repositoryQueueKey(item);
    let queue = queuesByRepository.get(key);
    if (!queue) {
      queue = { items: [] };
      queuesByRepository.set(key, queue);
      queues.push(queue);
    }
    queue.items.push(item);
  }

  for (const queue of queues) {
    queue.items = prioritizeRequestedCandidates(queue.items);
  }
  return roundRobinQueues(queues).map(({ item }) => item);
}

export function roundRobinAccountQueues(accountQueues) {
  const queues = accountQueues.map(({ account, items }) => ({
    account,
    items: interleaveRepositoryQueues(items),
  }));
  const result = [];
  for (const { queue, item } of roundRobinQueues(queues)) {
    result.push({ account: queue.account, ...item });
  }
  return result;
}

export function selectConfiguredAccounts(accounts, selector) {
  if (!selector) return accounts;
  const requestedLabel = `${selector.username}@${selector.hostname}`.toLowerCase();
  const matches = accounts.filter(
    (account) => accountLabel(account).toLowerCase() === requestedLabel,
  );
  if (matches.length === 0) {
    throw new Error(
      `account ${selector.username}@${selector.hostname} is not configured`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `account ${selector.username}@${selector.hostname} is ambiguous across providers`,
    );
  }
  return matches;
}

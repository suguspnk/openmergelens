import { createHash } from 'node:crypto';

const CONSENT_SCOPE_PATTERN = /^sha256:[a-f0-9]{64}$/;

function selectedRepositoryEntries(accounts) {
  if (!Array.isArray(accounts)) return null;
  const selected = [];
  for (const account of accounts) {
    const isBitbucket = typeof account?.accountId === 'string';
    if (
      typeof account?.hostname !== 'string' ||
      (!isBitbucket && typeof account?.username !== 'string') ||
      !Array.isArray(account?.repositories) ||
      account.repositories.some((repository) => typeof repository !== 'string')
    ) {
      return null;
    }
    const accountKey = isBitbucket
      ? `bitbucket.org@${account.accountId.toLowerCase()}`
      : `${account.hostname.toLowerCase()}@${account.username.toLowerCase()}`;
    for (const repository of account.repositories) {
      selected.push(`${accountKey}::${repository.toLowerCase()}`);
    }
  }
  return selected.sort();
}

export function aiProcessingConsentScope(reviewerCommand, accounts) {
  if (typeof reviewerCommand !== 'string' || !reviewerCommand) return null;
  const repositories = selectedRepositoryEntries(accounts);
  if (repositories === null) return null;
  const digest = createHash('sha256')
    .update(JSON.stringify({ reviewerCommand, repositories }))
    .digest('hex');
  return `sha256:${digest}`;
}

export function createAiProcessingConsent(reviewerCommand, accounts) {
  const scope = aiProcessingConsentScope(reviewerCommand, accounts);
  if (scope === null) {
    throw new Error('AI-processing consent scope is invalid');
  }
  return { granted: true, scope };
}

export function normalizeAiProcessingConsent(consent) {
  if (consent === undefined || consent === null) return null;
  if (!consent || typeof consent !== 'object' || Array.isArray(consent)) {
    throw new Error('config.json aiProcessingConsent must be a consent object');
  }
  const unknown = Object.keys(consent).find(
    (field) => field !== 'granted' && field !== 'scope',
  );
  if (unknown) {
    throw new Error(
      `config.json aiProcessingConsent contains unsupported field "${unknown}"`,
    );
  }
  if (consent.granted !== true || !CONSENT_SCOPE_PATTERN.test(consent.scope)) {
    throw new Error(
      'config.json aiProcessingConsent must contain granted=true and a sha256 scope',
    );
  }
  return { granted: true, scope: consent.scope };
}

export function hasAiProcessingConsent(config) {
  const accounts = [
    ...(config?.githubAccounts || []),
    ...(config?.bitbucketAccounts || []),
  ];
  const expectedScope = aiProcessingConsentScope(
    config?.reviewerCommand,
    accounts,
  );
  return config?.aiProcessingConsent?.granted === true &&
    config.aiProcessingConsent.scope === expectedScope;
}

export function retainAiProcessingConsent(
  consent,
  previousReviewerCommand,
  nextReviewerCommand,
  previousAccounts,
  nextAccounts,
) {
  const previousConfig = {
    aiProcessingConsent: consent,
    reviewerCommand: previousReviewerCommand,
    githubAccounts: previousAccounts,
  };
  if (!hasAiProcessingConsent(previousConfig)) return null;
  const previousScope = aiProcessingConsentScope(
    previousReviewerCommand,
    previousAccounts,
  );
  const nextScope = aiProcessingConsentScope(nextReviewerCommand, nextAccounts);
  return previousScope === nextScope ? consent : null;
}

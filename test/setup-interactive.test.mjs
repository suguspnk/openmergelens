import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configureBitbucketAccounts,
  configureGitHubAccounts,
  initialProviderSelections,
} from '../lib/setup-interactive.mjs';

function quietPrompts(
  autocompleteMultiselect,
  text = async () => '',
  select = async () => 'done',
) {
  return {
    autocompleteMultiselect,
    text,
    select,
    isCancel: () => false,
    log: { success: () => {} },
    spinner: () => ({ start: () => {}, stop: () => {} }),
  };
}

test('fresh provider selection defaults to GitHub and restores configured providers', () => {
  assert.deepEqual(initialProviderSelections(null), ['github']);
  assert.deepEqual(initialProviderSelections({
    githubAccounts: [{ username: 'alice' }],
    bitbucketAccounts: [{ accountId: '{123e4567-e89b-42d3-a456-426614174000}' }],
  }), ['github', 'bitbucket']);
});
test('GitHub account configuration retains the established authenticated flow', async () => {
  const selected = { hostname: 'github.com', username: 'alice', active: true };
  const prompts = quietPrompts(async ({ message, options, initialValues }) => {
    if (message.startsWith('Which GitHub accounts')) {
      assert.deepEqual(initialValues, ['github.com@alice']);
      return [options[0].value];
    }
    assert.deepEqual(initialValues, ['OWNER/Repo']);
    return ['OWNER/Repo'];
  });
  const accounts = await configureGitHubAccounts({
    existingAccounts: [{ ...selected, repositories: ['owner/repo'] }],
    prompts,
    listAccounts: async () => [selected],
    resolveAuth: async () => ({ token: 'not-persisted' }),
    requestUsername: async () => 'alice',
    listRepos: async () => [{ nameWithOwner: 'OWNER/Repo', isPrivate: true }],
  });
  assert.deepEqual(accounts, [{
    hostname: 'github.com',
    username: 'alice',
    repositories: ['OWNER/Repo'],
  }]);
});

test('Bitbucket account configuration discovers UUID and persists only safe account fields', async () => {
  const accountId = '{123e4567-e89b-42d3-a456-426614174000}';
  const prompts = quietPrompts(
    async ({ message, options }) => {
      if (message.startsWith('Which Bitbucket Cloud accounts')) {
        return [options.at(-1).value];
      }
      return ['Workspace/Repo'];
    },
    async () => ' reviewer@example.com ',
  );
  const accounts = await configureBitbucketAccounts({
    prompts,
    discoverAccount: async (username) => {
      assert.equal(username, 'reviewer@example.com');
      return {
        account: {
          hostname: 'bitbucket.org',
          accountId,
          credentialUsername: username,
        },
        auth: { username, password: 'must-not-persist' },
      };
    },
    listRepos: async ({ auth }) => {
      assert.equal(auth.password, 'must-not-persist');
      return [{ nameWithOwner: 'Workspace/Repo', isPrivate: true }];
    },
  });
  assert.deepEqual(accounts, [{
    hostname: 'bitbucket.org',
    accountId,
    credentialUsername: 'reviewer@example.com',
    repositories: ['Workspace/Repo'],
  }]);
  assert.equal(JSON.stringify(accounts).includes('must-not-persist'), false);
});

test('retained Bitbucket accounts are verified before repository selection', async () => {
  const existing = {
    hostname: 'bitbucket.org',
    accountId: '{123e4567-e89b-42d3-a456-426614174000}',
    credentialUsername: 'reviewer@example.com',
    repositories: ['Workspace/Repo'],
  };
  let repoPrompted = false;
  const prompts = quietPrompts(async ({ message }) => {
    if (message.startsWith('Which Bitbucket Cloud accounts')) return [existing.accountId];
    repoPrompted = true;
    return ['Workspace/Repo'];
  });
  await assert.rejects(
    configureBitbucketAccounts({
      existingAccounts: [existing],
      prompts,
      resolveAuth: async () => { throw new Error('different account UUID'); },
      listRepos: async () => { throw new Error('must not run'); },
    }),
    /different account UUID/u,
  );
  assert.equal(repoPrompted, false);
});

test('Bitbucket account configuration rejects an empty repository result after prompting', async () => {
  const existing = {
    hostname: 'bitbucket.org',
    accountId: '{123e4567-e89b-42d3-a456-426614174000}',
    credentialUsername: 'reviewer@example.com',
    repositories: ['Workspace/Repo'],
  };
  const prompts = quietPrompts(async ({ message }) =>
    message.startsWith('Which Bitbucket Cloud accounts') ? [existing.accountId] : []);
  await assert.rejects(
    configureBitbucketAccounts({
      existingAccounts: [existing],
      prompts,
      resolveAuth: async () => ({ username: existing.credentialUsername, password: 'fixture' }),
      listRepos: async () => [{ nameWithOwner: 'Workspace/Repo', isPrivate: true }],
    }),
    /Select at least one repository/u,
  );
});

test('Bitbucket account configuration rejects a newly discovered duplicate UUID', async () => {
  const existing = {
    hostname: 'bitbucket.org',
    accountId: '{123e4567-e89b-42d3-a456-426614174000}',
    credentialUsername: 'reviewer@example.com',
    repositories: ['Workspace/Repo'],
  };
  const prompts = quietPrompts(
    async ({ message, options }) => message.startsWith('Which Bitbucket Cloud accounts')
      ? [existing.accountId, options.at(-1).value]
      : ['Workspace/Repo'],
    async () => 'duplicate@example.com',
  );
  await assert.rejects(
    configureBitbucketAccounts({
      existingAccounts: [existing],
      prompts,
      resolveAuth: async () => ({ username: existing.credentialUsername, password: 'fixture' }),
      discoverAccount: async () => ({
        account: { ...existing, credentialUsername: 'duplicate@example.com' },
        auth: { username: 'duplicate@example.com', password: 'fixture' },
      }),
      listRepos: async () => { throw new Error('must not list repositories'); },
    }),
    /already selected/u,
  );
});

test('Bitbucket account configuration can discover two fresh accounts before repo selection', async () => {
  const usernames = ['first@example.com', 'second@example.com'];
  const ids = [
    '{123e4567-e89b-42d3-a456-426614174000}',
    '{223e4567-e89b-42d3-a456-426614174000}',
  ];
  let textIndex = 0;
  let actionIndex = 0;
  let repoPromptIndex = 0;
  const prompts = quietPrompts(
    async ({ message, options }) => message.startsWith('Which Bitbucket Cloud accounts')
      ? [options.at(-1).value]
      : [`Workspace/Repo${++repoPromptIndex}`],
    async () => usernames[textIndex++],
    async () => ['add', 'done'][actionIndex++],
  );
  const accounts = await configureBitbucketAccounts({
    prompts,
    discoverAccount: async (username) => {
      const index = usernames.indexOf(username);
      return {
        account: {
          hostname: 'bitbucket.org',
          accountId: ids[index],
          credentialUsername: username,
        },
        auth: { username, password: `fixture-${index}` },
      };
    },
    listRepos: async ({ auth }) => [{
      nameWithOwner: `Workspace/Repo${usernames.indexOf(auth.username) + 1}`,
      isPrivate: true,
    }],
  });
  assert.deepEqual(accounts.map(({ accountId, credentialUsername, repositories }) => ({
    accountId,
    credentialUsername,
    repositories,
  })), [
    { accountId: ids[0], credentialUsername: usernames[0], repositories: ['Workspace/Repo1'] },
    { accountId: ids[1], credentialUsername: usernames[1], repositories: ['Workspace/Repo2'] },
  ]);
  assert.equal(JSON.stringify(accounts).includes('fixture-'), false);
});

test('Bitbucket repeated add rejects a duplicate UUID on a later discovery', async () => {
  const accountId = '{123e4567-e89b-42d3-a456-426614174000}';
  let textIndex = 0;
  const prompts = quietPrompts(
    async ({ options }) => [options.at(-1).value],
    async () => ['first@example.com', 'duplicate@example.com'][textIndex++],
    async () => 'add',
  );
  await assert.rejects(
    configureBitbucketAccounts({
      prompts,
      discoverAccount: async (username) => ({
        account: { hostname: 'bitbucket.org', accountId, credentialUsername: username },
        auth: { username, password: 'fixture' },
      }),
      listRepos: async () => { throw new Error('must not list repositories'); },
    }),
    /already selected/u,
  );
});

test('cancelling the repeated Bitbucket add prompt aborts before repository discovery', async () => {
  const cancelled = Symbol('cancelled');
  let listed = false;
  const prompts = {
    ...quietPrompts(
      async ({ options }) => [options.at(-1).value],
      async () => 'first@example.com',
      async () => cancelled,
    ),
    isCancel: (value) => value === cancelled,
  };
  await assert.rejects(
    configureBitbucketAccounts({
      prompts,
      onCancel: () => { throw cancelled; },
      discoverAccount: async (username) => ({
        account: {
          hostname: 'bitbucket.org',
          accountId: '{123e4567-e89b-42d3-a456-426614174000}',
          credentialUsername: username,
        },
        auth: { username, password: 'fixture' },
      }),
      listRepos: async () => { listed = true; return []; },
    }),
    (error) => error === cancelled,
  );
  assert.equal(listed, false);
});

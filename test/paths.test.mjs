import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { homedir } from 'node:os';
import { userHome, userPath, resolveUserPath } from '../lib/paths.mjs';

test('userHome defaults to ~/.openmergelens when OPENMERGELENS_HOME is unset', (t) => {
  const original = process.env.OPENMERGELENS_HOME;
  delete process.env.OPENMERGELENS_HOME;
  t.after(() => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
  });

  assert.equal(userHome(), path.join(homedir(), '.openmergelens'));
});

test('userHome respects OPENMERGELENS_HOME override', (t) => {
  const original = process.env.OPENMERGELENS_HOME;
  process.env.OPENMERGELENS_HOME = '/tmp/custom-openmergelens-home';
  t.after(() => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
  });

  assert.equal(userHome(), '/tmp/custom-openmergelens-home');
});

test('userHome resolves a relative OPENMERGELENS_HOME override', (t) => {
  const original = process.env.OPENMERGELENS_HOME;
  process.env.OPENMERGELENS_HOME = './relative-openmergelens-home';
  t.after(() => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
  });

  assert.equal(
    userHome(),
    path.resolve('./relative-openmergelens-home'),
  );
  assert.equal(
    userPath('config.json'),
    path.resolve('./relative-openmergelens-home/config.json'),
  );
});

test('userPath joins segments onto the user home', (t) => {
  const original = process.env.OPENMERGELENS_HOME;
  const customHome = path.join(path.parse(process.cwd()).root, 'tmp', 'custom-openmergelens-home');
  process.env.OPENMERGELENS_HOME = customHome;
  t.after(() => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
  });

  assert.equal(userPath('config.json'), path.join(customHome, 'config.json'));
  assert.equal(userPath('docs', 'checklist.md'), path.join(customHome, 'docs', 'checklist.md'));
  assert.equal(userPath(), customHome);
});

test('resolveUserPath leaves an absolute path untouched', (t) => {
  const original = process.env.OPENMERGELENS_HOME;
  process.env.OPENMERGELENS_HOME = '/tmp/custom-openmergelens-home';
  t.after(() => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
  });

  // The bug this guards against: path.join(userHome(), absPath) does NOT
  // collapse to absPath, so an absolute config value (e.g. a custom
  // stateFile) must bypass userPath() entirely rather than being joined.
  assert.equal(resolveUserPath('/absolute/path/state.json'), '/absolute/path/state.json');
});

test('resolveUserPath resolves a relative path against the user home', (t) => {
  const original = process.env.OPENMERGELENS_HOME;
  const customHome = path.join(path.parse(process.cwd()).root, 'tmp', 'custom-openmergelens-home');
  process.env.OPENMERGELENS_HOME = customHome;
  t.after(() => {
    if (original === undefined) delete process.env.OPENMERGELENS_HOME;
    else process.env.OPENMERGELENS_HOME = original;
  });

  assert.equal(resolveUserPath('./state.json'), path.join(customHome, 'state.json'));
  assert.equal(resolveUserPath('docs/checklist.md'), path.join(customHome, 'docs', 'checklist.md'));
});

test('Windows review state paths remain inside the private user home', () => {
  const options = {
    platform: 'win32',
    homeDirectory: 'C:\\Users\\octocat\\.openmergelens',
    osHomeDirectory: 'C:\\Users\\octocat',
  };

  assert.equal(
    resolveUserPath('.\\state.json', options),
    'C:\\Users\\octocat\\.openmergelens\\state.json',
  );
  assert.equal(
    resolveUserPath('c:\\users\\OCTOCAT\\.openmergelens\\review-state.json', options),
    'c:\\users\\OCTOCAT\\.openmergelens\\review-state.json',
  );
  for (const unsafe of [
    'nested\\state.json',
    'state.json:alternate-stream',
    'CON',
    'PRN.json',
    'AUX.log',
    'NUL.json',
    'CLOCK$.txt',
    'CONOUT$.log',
    'COM1.txt',
    'COM9.txt',
    'COM¹.txt',
    'COM².log',
    'COM³',
    'LPT1.txt',
    'LPT9.txt',
    'LPT¹.txt',
    'LPT².log',
    'LPT³',
    'CONIN$.txt',
    'state.json.',
    'state.json ',
    '..\\state.json',
    'C:\\Users\\octocat\\state.json',
    '\\\\server\\share\\state.json',
  ]) {
    assert.throws(
      () => resolveUserPath(unsafe, options),
      /must be a direct file in the default per-user OpenMergeLens home/u,
    );
  }
});

test('Windows rejects a non-default OpenMergeLens home', () => {
  const options = {
    platform: 'win32',
    environment: {
      OPENMERGELENS_HOME: 'C:\\shared\\openmergelens',
    },
    osHomeDirectory: 'C:\\Users\\octocat',
  };

  assert.throws(
    () => userHome(options),
    /must use the default per-user location/u,
  );
  assert.throws(
    () => resolveUserPath('.\\state.json', {
      platform: 'win32',
      homeDirectory: options.environment.OPENMERGELENS_HOME,
      osHomeDirectory: options.osHomeDirectory,
    }),
    /must be a direct file in the default per-user OpenMergeLens home/u,
  );
});

test('Windows accepts an equivalent canonical default home override', () => {
  assert.equal(
    userHome({
      platform: 'win32',
      environment: {
        OPENMERGELENS_HOME: 'c:\\users\\OCTOCAT\\.openmergelens',
      },
      osHomeDirectory: 'C:\\Users\\octocat',
    }),
    'C:\\Users\\octocat\\.openmergelens',
  );
});

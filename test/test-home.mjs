import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Windows review state is intentionally confined to the canonical
// per-user OpenMergeLens directory. Tests still need isolated homes, so use
// each temporary directory as a synthetic user profile and point the child
// environment at its canonical `.openmergelens` directory.
export async function createTestHome(t, prefix) {
  const profile = await mkdtemp(path.join(tmpdir(), prefix));
  const home = process.platform === 'win32'
    ? path.win32.join(path.win32.resolve(profile), '.openmergelens')
    : profile;
  if (process.platform === 'win32') await mkdir(home, { recursive: true });
  t.after(() => rm(profile, { recursive: true, force: true }));
  return home;
}

export function environmentWithTestHome(environment, home) {
  if (process.platform !== 'win32') {
    return { ...environment, OPENMERGELENS_HOME: home };
  }
  const profile = path.win32.dirname(path.win32.resolve(home));
  return {
    ...environment,
    USERPROFILE: profile,
    HOME: profile,
    OPENMERGELENS_HOME: path.win32.resolve(home),
  };
}

export function setProcessTestHome(t, home) {
  const names = ['OPENMERGELENS_HOME', 'USERPROFILE', 'HOME'];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const environment = environmentWithTestHome(process.env, home);
  for (const name of names) {
    if (environment[name] === undefined) delete process.env[name];
    else process.env[name] = environment[name];
  }
  t.after(() => {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });
}

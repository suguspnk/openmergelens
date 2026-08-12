import path from 'node:path';
import { homedir } from 'node:os';

// All per-user state (config, poll state, logs, customized prompts/learnings)
// lives under one directory outside the package install, so OpenMergeLens works
// the same whether it's a global npm install, an npx run, or a local clone,
// and survives `npm update`/reinstall, which would otherwise wipe anything
// written inside node_modules.
export function userHome() {
  const configuredHome = process.env.OPENMERGELENS_HOME;
  if (configuredHome) {
    return path.isAbsolute(configuredHome)
      ? configuredHome
      : path.resolve(configuredHome);
  }
  return path.join(homedir(), '.openmergelens');
}

export function userPath(...segments) {
  return path.join(userHome(), ...segments);
}

// path.join(userHome(), absPath) does not collapse to absPath, so callers
// resolving the possibly-absolute, possibly-relative stateFile config value
// need this instead of a plain userPath() call.
export function resolveUserPath(
  filePath,
  {
    platform = process.platform,
    homeDirectory = userHome(),
  } = {},
) {
  if (platform !== 'win32') {
    return path.isAbsolute(filePath) ? filePath : path.join(homeDirectory, filePath);
  }

  // Node has no portable Windows ACL inspection primitive. Keep review state
  // under the already-private OpenMergeLens home instead of accepting a custom
  // parent whose access control cannot be verified here.
  const home = path.win32.resolve(homeDirectory);
  const resolved = path.win32.isAbsolute(filePath)
    ? path.win32.resolve(filePath)
    : path.win32.resolve(home, filePath);
  const relative = path.win32.relative(home, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.win32.sep}`) ||
    path.win32.isAbsolute(relative)
  ) {
    throw new Error(
      'Windows review state path must remain within OPENMERGELENS_HOME',
    );
  }
  return resolved;
}

import path from 'node:path';
import { homedir } from 'node:os';

// All per-user state (config, poll state, logs, customized prompts/learnings)
// lives under one directory outside the package install, so OpenMergeLens works
// the same whether it's a global npm install, an npx run, or a local clone,
// and survives `npm update`/reinstall, which would otherwise wipe anything
// written inside node_modules.
export function userHome({
  platform = process.platform,
  environment = process.env,
  osHomeDirectory = homedir(),
} = {}) {
  const configuredHome = environment.OPENMERGELENS_HOME;
  if (platform === 'win32') {
    const defaultHome = path.win32.join(
      path.win32.resolve(osHomeDirectory),
      '.openmergelens',
    );
    if (configuredHome) {
      const configured = path.win32.isAbsolute(configuredHome)
        ? path.win32.resolve(configuredHome)
        : path.win32.resolve(configuredHome);
      if (configured.toLowerCase() !== defaultHome.toLowerCase()) {
        throw new Error(
          'Windows OPENMERGELENS_HOME must use the default per-user location',
        );
      }
    }
    return defaultHome;
  }
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
    osHomeDirectory = homedir(),
  } = {},
) {
  if (platform !== 'win32') {
    return path.isAbsolute(filePath) ? filePath : path.join(homeDirectory, filePath);
  }

  // Node has no portable Windows ACL/reparse-point inspection primitive. Use
  // only a direct file in the canonical per-user OpenMergeLens directory.
  const defaultHome = path.win32.join(
    path.win32.resolve(osHomeDirectory),
    '.openmergelens',
  );
  const home = path.win32.resolve(homeDirectory);
  const resolved = path.win32.isAbsolute(filePath)
    ? path.win32.resolve(filePath)
    : path.win32.resolve(home, filePath);
  const relative = path.win32.relative(home, resolved);
  const requestedName = path.win32.basename(filePath);
  const deviceStem = requestedName
    .split('.')[0]
    .replace(/[ .]+$/u, '')
    .toUpperCase();
  if (
    home.toLowerCase() !== defaultHome.toLowerCase() ||
    relative === '..' ||
    relative.startsWith(`..${path.win32.sep}`) ||
    path.win32.isAbsolute(relative) ||
    relative.includes(path.win32.sep) ||
    /[<>:"|?*\u0000-\u001F]/u.test(requestedName) ||
    /[ .]$/u.test(requestedName) ||
    /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u
      .test(deviceStem) ||
    !relative
  ) {
    throw new Error(
      'Windows review state must be a direct file in the default per-user OpenMergeLens home',
    );
  }
  return resolved;
}

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const initTestPath = path.join('e2e', 'init.e2e.mjs');
const backends = ['claude', 'codex'];
const schedulerModes = ['manual', ...(process.platform === 'darwin' || process.platform === 'linux'
  ? ['installed']
  : [])];

function runScenario(backend, schedulerMode, provider = 'github') {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', initTestPath],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          OPENMERGELENS_E2E_INIT_BACKEND: backend,
          OPENMERGELENS_E2E_INIT_SCHEDULER: schedulerMode,
          OPENMERGELENS_E2E_INIT_PROVIDER: provider,
        },
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

let failed = false;
for (const backend of backends) {
  for (const schedulerMode of schedulerModes) {
    console.error(`\n=== interactive init E2E: ${backend}, ${schedulerMode} scheduler ===`);
    try {
      const result = await runScenario(backend, schedulerMode);
      if (result.signal || result.code !== 0) failed = true;
    } catch (error) {
      failed = true;
      console.error(`could not start ${backend} init E2E (${schedulerMode}): ${error.message}`);
    }
  }
}
console.error('\n=== interactive init E2E: claude, manual scheduler, Bitbucket only ===');
try {
  const result = await runScenario('claude', 'manual', 'bitbucket');
  if (result.signal || result.code !== 0) failed = true;
} catch (error) {
  failed = true;
  console.error(`could not start Bitbucket-only init E2E: ${error.message}`);
}
process.exitCode = failed ? 1 : 0;

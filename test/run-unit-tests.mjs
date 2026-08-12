import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  LARGE_STATE_TEST_TIMEOUT_MS,
  partitionPatterns,
  TEST_TIMEOUT_MS,
} from './test-partitions.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(testDirectory);
const partitionedFiles = new Set([
  'poller-legacy-large-state.test.mjs',
  'poller-performance.test.mjs',
  'poller-state-gc-capacity.test.mjs',
  'poller.test.mjs',
]);

const runs = [
  {
    files: (await readdir(testDirectory))
      .filter((name) => name.endsWith('.test.mjs') && !partitionedFiles.has(name))
      .sort()
      .map((name) => path.join('test', name)),
    timeoutMs: TEST_TIMEOUT_MS,
  },
  {
    files: [path.join('test', 'poller-legacy-large-state.test.mjs')],
    timeoutMs: LARGE_STATE_TEST_TIMEOUT_MS,
  },
  ...[...partitionPatterns].flatMap(([name, patterns]) =>
    patterns.map((pattern) => ({
      files: [path.join('test', name)],
      pattern,
      timeoutMs: TEST_TIMEOUT_MS,
    }))),
];

function executeRun({ files, pattern, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--test',
      '--test-concurrency=1',
      `--test-timeout=${timeoutMs}`,
    ];
    if (pattern !== undefined) args.push(`--test-name-pattern=${pattern}`);
    args.push(...files);

    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
        return;
      }
      reject(new Error(
        `test partition failed with ${signal === null ? `exit ${code}` : `signal ${signal}`}`,
      ));
    });
  });
}

for (const run of runs) {
  await executeRun(run);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { partitionPatterns } from './test-partitions.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

test('every partitioned test title runs exactly once', async () => {
  for (const [name, patternSources] of partitionPatterns) {
    const source = await readFile(path.join(testDirectory, name), 'utf8');
    const titles = [...source.matchAll(/\btest\(\s*'([^']+)'/gu)]
      .map((match) => match[1]);
    assert.ok(titles.length > 0, `${name} must contain discoverable tests`);
    const patterns = patternSources.map((pattern) => new RegExp(pattern, 'u'));
    for (const title of titles) {
      assert.equal(
        patterns.filter((pattern) => pattern.test(title)).length,
        1,
        `${name}: ${title}`,
      );
    }
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('deep-health verifier passes its mocked HTTP behavior tests', () => {
  const result = spawnSync('python3', ['scripts/check-deep-health.test.py'], {
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

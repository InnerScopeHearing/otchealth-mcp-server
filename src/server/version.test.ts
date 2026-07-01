import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVersionPayload } from './version.js';

test('buildVersionPayload prefers REVISION_STAMP over GIT_SHA', () => {
  const payload = buildVersionPayload({
    version: '1.2.3',
    revisionStamp: 'v1.2.3',
    gitSha: 'abc123',
    toolCount: 7,
    uptimeSeconds: 15,
  });

  assert.deepEqual(payload, {
    service: 'otchealth-mcp-server',
    version: '1.2.3',
    gitTag: 'v1.2.3',
    toolCount: 7,
    uptimeSeconds: 15,
  });
});

test('buildVersionPayload falls back from GIT_SHA to unknown when unset', () => {
  const withGitSha = buildVersionPayload({
    version: '1.2.3',
    gitSha: 'abc123',
    toolCount: 1,
    uptimeSeconds: 0,
  });
  assert.equal(withGitSha.gitTag, 'abc123');

  const unknown = buildVersionPayload({
    version: '1.2.3',
    toolCount: 1,
    uptimeSeconds: 0,
  });
  assert.equal(unknown.gitTag, 'unknown');
});

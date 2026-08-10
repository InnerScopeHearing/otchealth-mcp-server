import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = [
  'app-api-client.ts',
  'full-client.ts',
  'track-api-client.ts',
  'write-client.ts',
  'fly-client.ts',
] as const;

test('Customer.io client remediation guidance uses Azure Key Vault and contains no stale Notion/Railway path', () => {
  const sources = FILES.map((name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /Notion Token Vault|Notion vault|Matt's Notion vault|Railway logs/i);
  assert.match(sources, /kv-otc-55c84f6bef/);
  assert.match(sources, /cio-app-api-bearer/);
  assert.match(sources, /cio-site-id/);
  assert.match(sources, /cio-track-key/);
  assert.match(sources, /cio-fly-service-account-token/);
});

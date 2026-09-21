import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedBrowserUrl } from './agentcore-transport.js';

test('browser host policy rejects post-action redirect destinations outside an exact HTTPS host list', () => {
  assert.equal(isAllowedBrowserUrl('https://example.test/path', ['example.test']), true);
  assert.equal(isAllowedBrowserUrl('https://evil.example/path', ['example.test']), false);
  assert.equal(isAllowedBrowserUrl('https://user@example.test/path', ['example.test']), false);
  assert.equal(isAllowedBrowserUrl('http://example.test/path', ['example.test']), false);
});

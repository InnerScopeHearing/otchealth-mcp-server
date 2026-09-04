import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Regression lock for RFC 8252 loopback redirect acceptance at /register (2026-09-04).
 *
 * INCIDENT: the operator added our gateway to the ChatGPT desktop app's Codex MCP client and got
 * "Couldn't connect to otchealth. Try again." on Authenticate. Diagnosis from the live system:
 * discovery (/.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server) and the
 * unauthenticated 401 + WWW-Authenticate challenge all answered correctly, and no `oauth_register`
 * line ever appeared in the gateway log. That last part is NOT proof the client never called us:
 * /register logs on the SUCCESS path only, so its 400 invalid_redirect_uri return is silent. A
 * native client cannot use a fixed redirect -- it binds an ephemeral high port and sends
 * http://localhost:<random>/callback -- and OAUTH_REDIRECT_URIS is exact-string, so no such URI
 * could ever match.
 *
 * These tests pin the loopback rule itself. They read the source rather than importing the module
 * because oauth.ts pulls in the full env/config chain at import time; the rule is small, and a
 * source-level lock still fails loudly if someone narrows or deletes it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'oauth.ts'), 'utf8');

test('allowedRedirect consults the loopback rule BEFORE the exact-match allow-list', () => {
  const fn = SRC.slice(SRC.indexOf('function allowedRedirect'));
  const loopbackAt = fn.indexOf('isLoopbackRedirect(uri)');
  const listAt = fn.indexOf('OAUTH_REDIRECT_URIS');
  assert.ok(loopbackAt > 0, 'allowedRedirect must call isLoopbackRedirect');
  assert.ok(listAt > 0, 'allowedRedirect must still consult the configured allow-list');
  assert.ok(loopbackAt < listAt, 'the loopback check must run first: an ephemeral port can never be enumerated in config');
});

test('the loopback rule accepts localhost AND the IP literals (a literal-only rule would reject the real Codex client)', () => {
  for (const host of ["'127.0.0.1'", "'[::1]'", "'::1'", "'localhost'"]) {
    assert.ok(SRC.includes(host), `isLoopbackRedirect must accept ${host}`);
  }
});

test('the loopback rule stays narrow: http only, no query or fragment, unparseable rejected', () => {
  const fn = SRC.slice(SRC.indexOf('function isLoopbackRedirect'), SRC.indexOf('function allowedRedirect'));
  assert.match(fn, /u\.protocol !== 'http:'/, 'must require the http scheme for the loopback exception');
  assert.match(fn, /u\.search \|\| u\.hash/, 'must reject a redirect carrying a query string or fragment');
  assert.match(fn, /catch\s*{\s*\n?\s*return false/, 'an unparseable URI must be rejected, never accepted by default');
});

test('the non-loopback path is unchanged: still https-only when no allow-list is configured', () => {
  const fn = SRC.slice(SRC.indexOf('function allowedRedirect'));
  assert.match(fn, /\^https:\\\/\\\/\/i\.test\(uri\)/, 'the empty-allow-list fallback must still require https');
  assert.match(fn, /list\.includes\(uri\)/, 'a configured allow-list must still be exact-match for non-loopback URIs');
});

test('SECURITY: the DCR external-read hard-binding comment is still present and was not loosened alongside this change', () => {
  assert.match(SRC, /hard-bound to the non-privileged 'external-read' lane/,
    'the Part 6 hard-binding must remain: widening redirects must never widen lane reachability');
});

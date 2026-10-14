import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

import { registerIntercomLoginPage } from './intercom-login-page.js';

test('Intercom login page is non-cacheable and keeps the link token in a cleared fragment', async () => {
  const app = Fastify();
  registerIntercomLoginPage(app);
  try {
    const response = await app.inject({ method: 'GET', url: '/browser/login' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['cache-control'] ?? '', /no-store/);
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    const csp = response.headers['content-security-policy'] ?? '';
    assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.match(response.body, /history\.replaceState\(null, '', window\.location\.pathname\)/);
    assert.match(response.body, /\/browser\/login\/exchange/);
    assert.match(response.body, /\/browser\/login\/complete/);
    assert.match(response.body, /dcv\.authenticate\(signedUrl/);
    assert.match(response.body, /window\.dcv\.connect\(\{/);
    assert.match(response.body, /httpExtraSearchParams: extraParams/);
    assert.match(response.body, /Never paste credentials into chat or this page/);
    assert.doesNotMatch(response.body, /console\.(?:log|error|warn)/);
    const inlineScript = response.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(inlineScript);
    assert.doesNotThrow(() => new Function(inlineScript));
  } finally {
    await app.close();
  }
});

test('Intercom login assets are served only from the vendored SDK tree with license notices', async () => {
  const app = Fastify();
  registerIntercomLoginPage(app);
  try {
    const license = await app.inject({ method: 'GET', url: '/browser/login/assets/dcvjs-umd/EULA.txt' });
    assert.equal(license.statusCode, 200);
    assert.match(license.body, /END-USER LICENSE AGREEMENT/);
    assert.equal(license.headers['referrer-policy'], 'no-referrer');
    assert.match(license.headers['cache-control'] ?? '', /no-store/);

    const sdk = await app.inject({ method: 'GET', url: '/browser/login/assets/dcvjs-umd/dcv.js' });
    assert.equal(sdk.statusCode, 200);
    assert.match(sdk.headers['content-type'] ?? '', /javascript/);
    assert.ok(sdk.body.length > 100_000);

    const traversal = await app.inject({ method: 'GET', url: '/browser/login/assets/%2e%2e/package.json' });
    assert.notEqual(traversal.statusCode, 200);
    const unexpectedType = await app.inject({ method: 'GET', url: '/browser/login/assets/dcvjs-umd/README.md' });
    assert.notEqual(unexpectedType.statusCode, 200);
  } finally {
    await app.close();
  }
});

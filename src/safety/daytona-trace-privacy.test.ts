import test from 'node:test';
import assert from 'node:assert/strict';
import { daytonaTracePrivacyOptions } from './daytona-trace-privacy.js';

test('private preview hostnames and expire-token paths are excluded from outbound spans and propagation', () => {
  const options = daytonaTracePrivacyOptions('private.example.test');
  for (const settings of [options.http.client, options.undici]) {
    const blocked = settings.blocklist[0];
    assert.equal(settings.propagationBlocklist[0], blocked);
    for (const url of ['https://6080-public-unit-token.proxy.daytona.works/vnc.html', 'https://app.daytona.io/api/sandbox/public-unit/ports/6080/signed-preview-url/public-unit-token/expire', 'https://6080-public-unit-token.private.example.test/vnc.html', '/api/sandbox/public-unit/ports/6080/signed-preview-url/public-unit-token/expire']) assert.equal(blocked(url), true);
    assert.equal(blocked('https://example.com/public'), false);
    assert.equal(blocked('https://api.example.test/signed-preview-url'), true);
    assert.equal(blocked('https://6080-public-unit-token.daytonaproxy01.net/vnc.html'), true);
    assert.equal(blocked('/signed-preview-url?expiresInSeconds=30'), true);
    assert.equal(blocked('/signed-preview-url-not-an-endpoint'), false);
    assert.equal(blocked('https://daytona.io.evil.example/public'), false);
    assert.equal(blocked('https://private.example.test.evil.example/public'), false);
  }
});

test('malformed custom preview configuration never causes URL or token logging', () => {
  const settings = daytonaTracePrivacyOptions('not a hostname').undici;
  assert.equal(settings.blocklist[0]('not a url'), false);
  assert.equal(settings.blocklist[0]('https://app.daytona.io/api/config'), true);
});

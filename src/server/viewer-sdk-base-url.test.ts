import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import Fastify from 'fastify';
import ts from 'typescript';
import { registerIntercomLoginPage, registerWebsiteLoginPage } from './intercom-login-page.js';

const ORIGIN = 'https://mcp.otchealth.app';
const EXPECTED_BASE = `${ORIGIN}/browser/login/assets/dcvjs-umd`;
const sdkRoot = resolve(dirname(fileURLToPath(import.meta.resolve('bedrock-agentcore/browser/live-view'))), 'nice-dcv-web-client-sdk');
const sdk = readFileSync(resolve(sdkRoot, 'dcvjs-umd/dcv.js'), 'utf8');
const sdkAst = ts.createSourceFile('dcv.js', sdk, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const marker = sdk.indexOf('A.baseUrl=A.baseUrl?A.baseUrl.replace(');
assert.ok(marker > 0, 'locate the installed DCV connect configuration normalizer');
let normalizer: ts.FunctionExpression | undefined;
function findNormalizer(node: ts.Node): void {
  if (node.getStart(sdkAst) > marker || node.end <= marker) return;
  if (ts.isFunctionExpression(node)) normalizer = node;
  ts.forEachChild(node, findNormalizer);
}
findNormalizer(sdkAst);
assert.ok(normalizer, 'use the actual vendored normalizer, not a rewritten copy');
const normalizeSource = normalizer.getText(sdkAst);

function normalize(baseUrl: string, pathname: string): string {
  const configuration = { url: 'https://viewer.example/live-view', sessionId: 'dummy', authToken: 'dummy', baseUrl };
  runInNewContext(`(${normalizeSource})(configuration)`, {
    configuration,
    window: { location: { origin: ORIGIN, pathname } },
    Xo: (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key),
    hE: { info: () => {}, error: () => {} },
  });
  return configuration.baseUrl;
}

test('both viewer asset bases survive the actual vendored DCV page-relative normalization and load secondary decoder assets', async () => {
  const app = Fastify(); registerIntercomLoginPage(app); registerWebsiteLoginPage(app);
  try {
    for (const pathname of ['/browser/login', '/browser/connect']) {
      const page = await app.inject({ method: 'GET', url: pathname });
      const expression = page.body.match(/baseUrl:\s*([^\n]+),\s*\n/)?.[1]; assert.ok(expression);
      const baseUrl = runInNewContext(expression, { URL, window: { location: { origin: ORIGIN } } }) as string;
      const normalized = normalize(baseUrl, pathname);
      assert.equal(normalized, EXPECTED_BASE, `DCV must not prepend ${pathname} to the SDK asset route`);
      for (const asset of ['/dcv/lz4decoder-worker.js', '/lib/lz4/lz4_decoder.js', '/dcv/broadwayh264decoder-worker.js']) {
        const url = new URL(`${normalized}${asset}`);
        assert.equal(url.origin, ORIGIN);
        const response = await app.inject({ method: 'GET', url: url.pathname });
        assert.equal(response.statusCode, 200, 'secondary SDK assets remain on the sole existing asset route');
      }
    }
  } finally { await app.close(); }
});

test('viewer scripts derive an absolute same-origin SDK base without changing the signed live-view URL', async () => {
  const app = Fastify(); registerIntercomLoginPage(app); registerWebsiteLoginPage(app);
  try {
    for (const pathname of ['/browser/login', '/browser/connect']) {
      const page = await app.inject({ method: 'GET', url: pathname });
      assert.match(page.body, /baseUrl: new URL\('\/browser\/login\/assets\/dcvjs-umd', window\.location\.origin\)\.href/);
      assert.match(page.body, /dcv\.authenticate\(signedUrl,/);
      assert.match(page.body, /url: signedUrl,/);
      assert.match(page.body, /httpExtraSearchParams: extraParams/);
    }
  } finally { await app.close(); }
});

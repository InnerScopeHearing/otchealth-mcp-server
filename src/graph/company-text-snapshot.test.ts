import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompanyTextSnapshotReader } from './company-text-snapshot.js';
import { resolveCompanyGraphScope } from '../server/company-graph-scope.js';

const hash = 'a'.repeat(64);
function legalScope() {
  const result = resolveCompanyGraphScope('clo', 'legal_company');
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.code);
  return result.scope;
}
function reader(caller = 'clo') {
  return createCompanyTextSnapshotReader({
    scope: legalScope(), callerContext: { caller_agent: caller, connector_surface: true },
    credentialProvider: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }),
    signer: input => ({ headers: input.extraHeaders ?? {} }),
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).pathname, '/otchealthlegalstore/company/_TEXT/company/synthetic.txt.txt');
      return init.method === 'HEAD'
        ? new Response('', { status: 200, headers: { etag: '"synthetic"', 'x-amz-version-id': 'v1', 'content-length': '4' } })
        : new Response('text', { status: 200, headers: { etag: '"synthetic"', 'x-amz-version-id': 'v1', 'content-length': '4' } });
    },
  });
}
const source = Object.freeze({ room: 'legal_company' as const, source_index: 'legal-company' as const, path: 'company/synthetic.txt', source_path_hash: hash, document_version_id: 'docv_'+hash, source_version: hash });

test('company source reader pins the closed CLO-company prefix and refuses personal tuples', async () => {
  const crypto = await import('node:crypto');
  const valid = Object.freeze({ ...source, source_path_hash: crypto.createHash('sha256').update(source.path).digest('hex') });
  const result = await reader().readVersionPinnedPage(valid);
  assert.equal(result.outcome, 'ready');
  if (result.outcome === 'ready') assert.equal(result.descriptor.room, 'legal_company');
  await assert.rejects(reader().readVersionPinnedPage(Object.freeze({ ...valid, source_index: 'finance-cfo-source-docs' })), { code: 'company_text_source_invalid' });
  assert.throws(() => reader('clo-personal'), { code: 'company_text_forbidden' });
});

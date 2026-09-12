import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCli, runXeroOrganisationSourceExport } from './xero-organisation-source-export-run.mjs';

const deployment = { schema: 'cfo-xero-organisation-source-deployment-v1', deployment: {
  org: 'otchealth', source_storage: {
    bucket: 'synthetic', prefix: 'graph-trial/20260912/identity-registry/cfo-pilot/source', region: 'us-east-1',
    approvedPolicyCanonicalSha256: 'a'.repeat(64), approvedStorageScopeSha256: 'b'.repeat(64), operationTimeoutMs: 1000,
    sse: { algorithm: 'AES256' },
  },
} };

test('accepts only absolute, exact deployment and output arguments', () => {
  assert.deepEqual(parseCli(['--deployment', 'C:\\source.json', '--output', 'C:\\result.json']), { deployment: 'C:\\source.json', output: 'C:\\result.json' });
  assert.equal(parseCli(['--deployment', 'relative.json', '--output', 'C:\\result.json']), null);
  assert.equal(parseCli(['--deployment', 'C:\\source.json', '--deployment', 'C:\\result.json']), null);
});

test('writes only the safe record and receipt after the source-owner adapter succeeds', async () => {
  let written;
  const result = await runXeroOrganisationSourceExport({
    argv: ['--deployment', 'C:\\source.json', '--output', 'C:\\result.json'],
    read: async () => JSON.stringify(deployment),
    persist: async value => {
      assert.deepEqual(value, deployment.deployment);
      return { projection: { TaxNumber: 'must-not-escape' }, record: { source_record_id: 'synthetic' }, receipt: { raw_response_persisted: false } };
    },
    write: async (_path, value, options) => { written = { value, options }; },
  });
  assert.deepEqual(result, { output_written: true });
  assert.equal(written.options.flag, 'wx');
  assert.equal(written.options.mode, 0o600);
  assert.ok(!written.value.includes('TaxNumber'));
  assert.deepEqual(JSON.parse(written.value), {
    schema: 'cfo-xero-organisation-source-export-result-v1', record: { source_record_id: 'synthetic' }, receipt: { raw_response_persisted: false },
  });
});

test('rejects deployment material containing a private key before invoking the adapter', async () => {
  await assert.rejects(runXeroOrganisationSourceExport({
    argv: ['--deployment', 'C:\\source.json', '--output', 'C:\\result.json'],
    read: async () => '-----BEGIN PRIVATE KEY-----',
    persist: async () => { throw Error('must not run'); },
    write: async () => { throw Error('must not run'); },
  }), { code: 'xero_organisation_deployment_invalid' });
});

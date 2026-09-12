#!/usr/bin/env node
/** One-off exporter: version-pinned Xero source projection -> signed registry export. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, publishExplicitIdentityRegistryExport } from './identity-registry-explicit-export.mjs';

const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9._~+/-]{1,1024}$/;
const MAX = 64 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const hash = body => createHash('sha256').update(body).digest('hex');
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\s]/.test(value);

export function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) return null;
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!['--handoff', '--ports', '--output'].includes(flag) || typeof value !== 'string' || !isAbsolute(value) || values.has(flag)) return null;
    values.set(flag, resolve(value));
  }
  return { handoff: values.get('--handoff'), ports: values.get('--ports'), output: values.get('--output') };
}
async function json(path, code, read = readFile) {
  let raw; try { raw = await read(path, 'utf8'); } catch { fail(code); }
  if (Buffer.byteLength(raw, 'utf8') < 1 || Buffer.byteLength(raw, 'utf8') > MAX || /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/.test(raw)) fail(code);
  try { return JSON.parse(raw); } catch { fail(code); }
}
function storage(value, code) {
  if (!exact(value, ['approved_policy_canonical_sha256','approved_storage_scope_sha256','bucket','prefix','region','sse']) ||
      !SHA.test(value.approved_policy_canonical_sha256) || !SHA.test(value.approved_storage_scope_sha256)) fail(code);
  return { bucket: value.bucket, prefix: value.prefix, region: value.region, approvedPolicyCanonicalSha256: value.approved_policy_canonical_sha256,
    approvedStorageScopeSha256: value.approved_storage_scope_sha256, sse: value.sse };
}
function handoff(value) {
  if (!exact(value, ['export_input','schema','source']) || value.schema !== 'cfo-xero-organisation-explicit-export-handoff-v1' ||
      !exact(value.source, ['key','sha256','storage','version_id']) || !text(value.source.key) || !SHA.test(value.source.sha256) || !VERSION.test(value.source.version_id) || value.source.version_id === 'null') fail('xero_export_handoff_invalid');
  return { input: value.export_input, source: { key: value.source.key, sha256: value.source.sha256, version_id: value.source.version_id, storage: storage(value.source.storage, 'xero_export_handoff_invalid') } };
}
function configuredPorts(value) {
  if (!exact(value, ['kms','schema','source_storage']) || value.schema !== 'cfo-identity-registry-explicit-export-ports-v1' || !exact(value.kms, ['key_id','region'])) fail('xero_export_ports_invalid');
  return { kms: value.kms, storage: storage(value.source_storage, 'xero_export_ports_invalid') };
}
function sseHeadersMatch(headers, sse) { return headers.get('x-amz-server-side-encryption') === sse.algorithm && (sse.algorithm !== 'aws:kms' || headers.get('x-amz-server-side-encryption-aws-kms-key-id') === sse.kmsKeyId); }

/** Core is injectable for tests; production receives only compiled runtime ports. */
export async function runXeroOrganisationExplicitExport({ argv, read = readFile, write = writeFile, runtimeFactory, bind, signerFactory, storeFactory, publish = publishExplicitIdentityRegistryExport } = {}) {
  const paths = parseCli(argv); if (!paths || typeof runtimeFactory !== 'function' || typeof bind !== 'function' || typeof signerFactory !== 'function' || typeof storeFactory !== 'function') fail('xero_export_arguments_invalid');
  const [rawHandoff, rawPorts] = await Promise.all([json(paths.handoff, 'xero_export_handoff_unavailable', read), json(paths.ports, 'xero_export_ports_unavailable', read)]);
  const hand = handoff(rawHandoff), ports = configuredPorts(rawPorts), runtime = runtimeFactory(hand.source.storage), signal = AbortSignal.timeout(30_000);
  await runtime.preflight(signal);
  const response = await runtime.request({ method: 'GET', key: hand.source.key, versionId: hand.source.version_id, signal });
  if (response.status !== 200 || response.headers.get('x-amz-version-id') !== hand.source.version_id || !sseHeadersMatch(response.headers, hand.source.storage.sse) || hash(response.body) !== hand.source.sha256) fail('xero_export_source_pin_invalid');
  let projection; try { projection = JSON.parse(response.body.toString('utf8')); } catch { fail('xero_export_source_pin_invalid'); }
  const bound = bind({ projection, sourceDocumentVersion: hand.source.version_id, sourceSha256: hand.source.sha256 });
  const input = { ...hand.input, records: [bound.record], bindings: [{ source_document_version: hand.source.version_id, chunk_sha256: hand.source.sha256 }] };
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || input.prefix !== ports.storage.prefix) fail('xero_export_destination_prefix_mismatch');
  const signer = await signerFactory({ region: ports.kms.region, keyId: ports.kms.key_id });
  const store = storeFactory(ports.storage);
  const result = await publish({ input, signer, store });
  await write(paths.output, canonicalJson({ schema: 'cfo-xero-organisation-explicit-export-result-v1', ...result }) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { output_written: true };
}
async function main() {
  try {
    const { createIdentityRegistryS3Runtime } = await import('../dist/server/identity-registry-s3-runtime.js');
    const { bindImmutableXeroOrganisationProjection } = await import('../dist/server/xero-organisation-source-adapter.js');
    const { createCfoIdentityRegistryKmsSigner, createExplicitExportImmutableStore } = await import('../dist/server/identity-registry-explicit-export-ports.js');
    await runXeroOrganisationExplicitExport({ argv: process.argv.slice(2), runtimeFactory: createIdentityRegistryS3Runtime, bind: bindImmutableXeroOrganisationProjection, signerFactory: createCfoIdentityRegistryKmsSigner, storeFactory: createExplicitExportImmutableStore });
    process.stdout.write(JSON.stringify({ schema: 'cfo-xero-organisation-explicit-export-run-v1', status: 'published', output_written: true }) + '\n');
  } catch (error) { process.stderr.write(`${error?.code ?? 'xero_export_unavailable'}\n`); process.exitCode = 1; }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();

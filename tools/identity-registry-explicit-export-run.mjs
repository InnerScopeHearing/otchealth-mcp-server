/**
 * Source-owner runner. It reads an explicit-ID input only from a supplied
 * local source-ring path and writes a public deployment receipt. It never
 * prints the input, private key material, AWS credentials, or source records.
 *
 * node tools/identity-registry-explicit-export-run.mjs --input C:\source\input.json --ports C:\source\ports.json --output C:\source\receipt.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { canonicalJson, publishExplicitIdentityRegistryExport } from './identity-registry-explicit-export.mjs';
import { createCfoIdentityRegistryKmsSigner, createExplicitExportImmutableStore } from './identity-registry-explicit-export-ports.mjs';

const SHA = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
function args(argv) {
  if (argv.length !== 6) fail('identity_export_arguments_invalid');
  const found = new Map();
  for (let index = 0; index < argv.length; index += 2) { const flag = argv[index], value = argv[index + 1]; if (!['--input', '--ports', '--output'].includes(flag) || typeof value !== 'string' || found.has(flag) || !isAbsolute(value)) fail('identity_export_arguments_invalid'); found.set(flag, resolve(value)); }
  return { input: found.get('--input'), ports: found.get('--ports'), output: found.get('--output') };
}
async function json(path, code) {
  let raw; try { raw = await readFile(path, 'utf8'); } catch { fail(code); }
  if (Buffer.byteLength(raw, 'utf8') < 1 || Buffer.byteLength(raw, 'utf8') > 8 * 1024 * 1024) fail(code);
  try { return JSON.parse(raw); } catch { fail(code); }
}
function ports(value) {
  if (!exact(value, ['kms', 'schema', 'source_storage']) || value.schema !== 'cfo-identity-registry-explicit-export-ports-v1' || !exact(value.kms, ['key_id', 'region']) ||
      !exact(value.source_storage, ['approved_policy_canonical_sha256', 'approved_storage_scope_sha256', 'bucket', 'prefix', 'region', 'sse']) ||
      !SHA.test(value.source_storage.approved_policy_canonical_sha256) || !SHA.test(value.source_storage.approved_storage_scope_sha256)) fail('identity_export_ports_invalid');
  return value;
}
try {
  const paths = args(process.argv.slice(2));
  const [input, configuredPorts] = await Promise.all([json(paths.input, 'identity_export_input_unavailable'), json(paths.ports, 'identity_export_ports_unavailable')]);
  const config = ports(configuredPorts);
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || input.prefix !== config.source_storage.prefix) fail('identity_export_source_prefix_mismatch');
  const signer = await createCfoIdentityRegistryKmsSigner({ region: config.kms.region, keyId: config.kms.key_id });
  const store = createExplicitExportImmutableStore({
    bucket: config.source_storage.bucket, prefix: config.source_storage.prefix, region: config.source_storage.region,
    approvedPolicyCanonicalSha256: config.source_storage.approved_policy_canonical_sha256,
    approvedStorageScopeSha256: config.source_storage.approved_storage_scope_sha256,
    sse: config.source_storage.sse,
  });
  const published = await publishExplicitIdentityRegistryExport({ input, signer, store });
  await writeFile(paths.output, canonicalJson({ schema: 'cfo-identity-registry-explicit-export-result-v1', ...published }) + '\n', { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(JSON.stringify({ schema: 'cfo-identity-registry-explicit-export-run-v1', status: 'published', output_written: true }) + '\n');
} catch (error) {
  process.stderr.write(`${error?.code === undefined ? 'identity_export_unavailable' : error.code}\n`);
  process.exitCode = 1;
}

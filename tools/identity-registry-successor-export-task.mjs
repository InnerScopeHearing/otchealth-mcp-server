import { createHash } from 'node:crypto';
import { canonicalJson } from './identity-registry-explicit-export.mjs';
import { run as runExporter, validatePorts } from './identity-registry-exporter-task.mjs';
import { reconcileHistoricalXeroOrganisationHandoff } from './xero-organisation-explicit-export-reconcile.mjs';

const MAX = 64 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const parse = (raw, code) => { if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') < 2 || Buffer.byteLength(raw, 'utf8') > MAX) fail(code); try { return JSON.parse(raw); } catch { fail(code); } };
const expiresAt = (value, now) => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= now + 1000 || Date.parse(value) > now + 24 * 60 * 60 * 1000) fail('identity_registry_successor_expiry_invalid'); return new Date(Date.parse(value)).toISOString(); };
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

/**
 * Builds one repaired export from only the exact legacy source-owned handoff.
 * The source pin, bucket policy hash, KMS identity, and encryption stay fixed.
 * Its only new storage namespace is derived from the immutable source SHA.
 */
export function prepareSuccessorTask({ legacyHandoffJson, rootPortsJson, expiresAt: requestedExpiry, now = Date.now } = {}) {
  if (typeof now !== 'function') fail('identity_registry_successor_arguments_invalid');
  const expiry = expiresAt(requestedExpiry, now());
  const legacy = parse(legacyHandoffJson, 'identity_registry_legacy_handoff_invalid');
  const basePorts = validatePorts(parse(rootPortsJson, 'identity_registry_exporter_ports_invalid'));
  if (basePorts.source_storage.prefix !== 'graph-trial/20260912/identity-registry/cfo-pilot/snapshots') fail('identity_registry_successor_root_storage_invalid');
  const reconciled = reconcileHistoricalXeroOrganisationHandoff(legacy, { expiresAt: expiry });
  const target = structuredClone(basePorts);
  target.source_storage.prefix = reconciled.receipt.required_successor_storage_prefix;
  target.source_storage.approved_storage_scope_sha256 = hash({ bucket: target.source_storage.bucket, prefix: target.source_storage.prefix, policy_sha256: target.source_storage.approved_policy_canonical_sha256 });
  validatePorts(target);
  if (target.source_storage.prefix !== `graph-trial/20260912/identity-registry/cfo-pilot/snapshots/reconciled/${reconciled.private_handoff.source.sha256}`) fail('identity_registry_successor_storage_binding_invalid');
  return Object.freeze({ handoff: reconciled.private_handoff, ports: Object.freeze(target), expiry, receipt: Object.freeze({ schema: 'cfo-identity-registry-successor-storage-attestation-v1', status: 'attested', source_pin_preserved: true, storage: Object.freeze(structuredClone(target.source_storage)), writes_performed: false }) });
}

export function run({ env = process.env, exporter = runExporter, now = Date.now } = {}) {
  const prepared = prepareSuccessorTask({ legacyHandoffJson: env.CFO_IDENTITY_REGISTRY_LEGACY_HANDOFF_JSON, rootPortsJson: env.CFO_IDENTITY_REGISTRY_PORTS_JSON, expiresAt: env.CFO_IDENTITY_REGISTRY_SUCCESSOR_EXPIRES_AT, now });
  const exported = exporter({ env: { ...env, CFO_IDENTITY_REGISTRY_HANDOFF_JSON: JSON.stringify(prepared.handoff), CFO_IDENTITY_REGISTRY_PORTS_JSON: JSON.stringify(prepared.ports) } });
  if (!exported || exported.schema !== 'cfo-identity-registry-exporter-task-v1' || exported.status !== 'published' || !exported.immutable_output_proof || !SHA.test(exported.immutable_output_proof.manifest?.sha256) || !SHA.test(exported.immutable_output_proof.pointer?.sha256)) fail('identity_registry_successor_export_failed');
  return Object.freeze({ schema: 'cfo-identity-registry-successor-export-task-v1', status: 'published', successor_storage_attestation: prepared.receipt, immutable_output_proof: exported.immutable_output_proof });
}

if (process.argv[1]?.endsWith('identity-registry-successor-export-task.mjs')) {
  try { process.stdout.write(JSON.stringify(run()) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ schema: 'cfo-identity-registry-successor-export-task-v1', status: 'error', code: typeof error?.code === 'string' ? error.code : 'identity_registry_successor_export_failed' }) + '\n'); process.exitCode = 1; }
}
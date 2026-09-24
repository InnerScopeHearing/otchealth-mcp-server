import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './identity-registry-explicit-export.mjs';
import { buildExportInput, REGISTRY_EXPORT_RUN_VERSION } from './xero-organisation-source-handoff-run.mjs';

const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9._~+/-]{1,1024}$/;
const SNAPSHOT_PREFIX = 'graph-trial/20260912/identity-registry/cfo-pilot/snapshots';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

function sourcePin(value) {
  if (!exact(value, ['key', 'sha256', 'storage', 'version_id']) || typeof value.key !== 'string' || !value.key.startsWith('graph-trial/20260912/identity-registry/cfo-pilot/source/identity-registries/xero-organisation/') || value.key.includes('/handoffs/') || !SHA.test(value.sha256) || !VERSION.test(value.version_id) || value.version_id === 'null') fail('identity_registry_legacy_handoff_invalid');
  return Object.freeze({ source_document_version: value.version_id, source_sha256: value.sha256 });
}

function legacyInput(record, expiresAt) {
  const legacyRun = { ref_version: 'neptune-trial-active-run-ref-v1', purpose: 'cfo_identity_registry_pilot', scope: 'finance', run_version: record.source_document_version, manifest_sha256: record.source_sha256 };
  return buildExportInput(record, { expiresAt, runVersion: legacyRun.run_version, });
}

/**
 * Converts only the known historical run-version defect into a successor
 * exporter handoff. The source pin and every non-run field must exactly match
 * the original source-generated shape. It never writes or changes the old
 * immutable handoff or its signed export.
 */
export function reconcileHistoricalXeroOrganisationHandoff(value, { expiresAt } = {}) {
  if (!exact(value, ['export_input', 'schema', 'source']) || value.schema !== 'cfo-xero-organisation-explicit-export-handoff-v1' || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) fail('identity_registry_legacy_handoff_invalid');
  const record = sourcePin(value.source), historical = legacyInput(record, value.export_input?.expires_at);
  if (canonicalJson(value.export_input) !== canonicalJson(historical)) fail('identity_registry_legacy_handoff_not_recognized');
  const successorPrefix = `${SNAPSHOT_PREFIX}/reconciled/${record.source_sha256}`;
  const repaired = buildExportInput(record, { expiresAt, prefix: successorPrefix });
  const runBody = { ref_version: repaired.run.ref_version, purpose: repaired.run.purpose, scope: repaired.run.scope, run_version: repaired.run.run_version, manifest_sha256: repaired.run.manifest_sha256 };
  if (repaired.run.run_version !== REGISTRY_EXPORT_RUN_VERSION || repaired.run.run_id !== `run_${digest(runBody)}`) fail('identity_registry_legacy_handoff_repair_invalid');
  const private_handoff = Object.freeze({ schema: value.schema, source: Object.freeze(structuredClone(value.source)), export_input: Object.freeze(repaired) });
  return Object.freeze({ schema: 'cfo-xero-organisation-explicit-export-reconciliation-v1', private_handoff, receipt: Object.freeze({ source_pin_sha256: digest(value.source), source_pin_preserved: true, required_successor_storage_prefix: successorPrefix, replaced_fields: Object.freeze(['expires_at', 'prefix', 'run.run_id', 'run.run_version']), run_version: REGISTRY_EXPORT_RUN_VERSION, writes_performed: false }) });
}

export function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) return null;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!['--handoff', '--expires-at', '--output'].includes(flag) || typeof value !== 'string' || !value || values.has(flag)) return null;
    if (flag !== '--expires-at' && !isAbsolute(value)) return null;
    values.set(flag, flag === '--expires-at' ? value : resolve(value));
  }
  return { handoff: values.get('--handoff'), expiresAt: values.get('--expires-at'), output: values.get('--output') };
}

/** Writes only a private successor handoff. Export and publication are separate actions. */
export async function prepareHistoricalXeroOrganisationReconciliation({ argv, read = readFile, write = writeFile } = {}) {
  const args = parseCli(argv);
  if (!args) fail('identity_registry_reconciliation_arguments_invalid');
  let raw, value;
  try { raw = await read(args.handoff, 'utf8'); } catch { fail('identity_registry_legacy_handoff_unavailable'); }
  if (Buffer.byteLength(raw, 'utf8') < 1 || Buffer.byteLength(raw, 'utf8') > 64 * 1024) fail('identity_registry_legacy_handoff_invalid');
  try { value = JSON.parse(raw); } catch { fail('identity_registry_legacy_handoff_invalid'); }
  const prepared = reconcileHistoricalXeroOrganisationHandoff(value, { expiresAt: args.expiresAt });
  await write(args.output, canonicalJson(prepared.private_handoff) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return prepared.receipt;
}

async function main() {
  try {
    const receipt = await prepareHistoricalXeroOrganisationReconciliation({ argv: process.argv.slice(2) });
    process.stdout.write(JSON.stringify({ schema: 'cfo-xero-organisation-explicit-export-reconciliation-v1', status: 'prepared', ...receipt }) + '\n');
  } catch (error) {
    process.stderr.write(String(error?.code ?? 'identity_registry_reconciliation_failed') + '\n');
    process.exitCode = 1;
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();

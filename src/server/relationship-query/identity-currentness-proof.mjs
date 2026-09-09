import { createHash } from 'node:crypto';
import { canonical } from './aws-http.mjs';

export const IDENTITY_CURRENTNESS_SCHEMA = 'source-identity-currentness-pointer-v1';
const HASH = /^[a-f0-9]{64}$/;
const TEXT = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !value.includes('\0');
const exact = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const frozen = value => Object.freeze(structuredClone(value));

function receipt(pointer, requestSha256) {
  const common = {
    registry_id: pointer.registry_id,
    public_key_sha256: pointer.public_key_sha256,
    snapshot_sha256: pointer.snapshot_sha256,
    entry_sha256: pointer.entry_sha256,
    request_sha256: requestSha256,
  };
  return pointer.mode === 'snapshot'
    ? { ...common, registry_version: pointer.registry_version }
    : { ...common, manifest_version: pointer.manifest_version,
      manifest_sha256: pointer.manifest_sha256, shard_id: pointer.shard_id };
}

/** Parse a durable pointer. It contains only immutable registry pins, never source text. */
export function parseIdentityCurrentnessPointer(value, requestSha256) {
  if (!HASH.test(requestSha256 ?? '') || !value || typeof value !== 'object') return null;
  const snapshotKeys = ['schema','mode','registry_id','registry_version','public_key_sha256','snapshot_sha256','entry_sha256','receipt_sha256'];
  const partitionKeys = ['schema','mode','registry_id','manifest_version','manifest_sha256','shard_id','public_key_sha256','snapshot_sha256','entry_sha256','receipt_sha256'];
  if (value.schema !== IDENTITY_CURRENTNESS_SCHEMA ||
      !(value.mode === 'snapshot' ? exact(value, snapshotKeys) : value.mode === 'partition' && exact(value, partitionKeys)) ||
      !TEXT(value.registry_id) || !HASH.test(value.public_key_sha256 ?? '') ||
      !HASH.test(value.snapshot_sha256 ?? '') || !HASH.test(value.entry_sha256 ?? '') ||
      !HASH.test(value.receipt_sha256 ?? '')) return null;
  if (value.mode === 'snapshot' ? !TEXT(value.registry_version) :
      !TEXT(value.manifest_version) || !HASH.test(value.manifest_sha256 ?? '') || !TEXT(value.shard_id)) return null;
  if (sha256(canonical(receipt(value, requestSha256))) !== value.receipt_sha256) return null;
  return frozen(value);
}

export function createIdentityCurrentnessPointer(fields, requestSha256) {
  const unsigned = { schema: IDENTITY_CURRENTNESS_SCHEMA, ...fields };
  const value = { ...unsigned, receipt_sha256: sha256(canonical(receipt(unsigned, requestSha256))) };
  const parsed = parseIdentityCurrentnessPointer(value, requestSha256);
  if (!parsed) throw Object.assign(new Error('identity_currentness_pointer_invalid'), { code: 'identity_currentness_pointer_invalid' });
  return parsed;
}

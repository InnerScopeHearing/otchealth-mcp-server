/**
 * Durable local adapter for a signed source-identity registry.
 *
 * This is a configurable filesystem component, not a shared production-store
 * configuration. Its only authority is immutable snapshot persistence and
 * durable version revocation. The broker remains responsible for signature,
 * binding, and source-currentness validation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm, stat, link } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const LABEL = /^[a-z0-9][a-z0-9_.:-]{0,95}$/;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,191}$/;
const MAX_ENVELOPE_BYTES = 256 * 1024;
// The persisted record JSON escapes the already bounded JSON envelope once.
// This permits its worst-case escaped representation plus fixed metadata.
const MAX_RECORD_BYTES = MAX_ENVELOPE_BYTES * 2 + 8 * 1024;
const MAX_JSON_DEPTH = 64;
const STORE_SCHEMA = 'identity-registry-snapshot-store-v1';

function canonical(value) {
  const ancestors = new Set();
  function visit(current, depth) {
    if (depth > MAX_JSON_DEPTH) throw new Error('identity_registry_store_json_too_deep');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('identity_registry_store_non_json_value');
      return JSON.stringify(current);
    }
    if (typeof current !== 'object' || Object.getPrototypeOf(current) !== Object.prototype && !Array.isArray(current)) {
      throw new Error('identity_registry_store_non_json_value');
    }
    if (ancestors.has(current)) throw new Error('identity_registry_store_json_cycle');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return '[' + current.map(item => visit(item, depth + 1)).join(',') + ']';
      return '{' + Object.keys(current).sort().map(key => JSON.stringify(key) + ':' + visit(current[key], depth + 1)).join(',') + '}';
    } finally {
      ancestors.delete(current);
    }
  }
  return visit(value, 0);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function rejectAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('identity_registry_store_aborted');
}

function validRegistryId(value) {
  return typeof value === 'string' && LABEL.test(value);
}

function validVersion(value) {
  return typeof value === 'string' && VERSION.test(value);
}

function boundedEnvelope(envelope) {
  const serialized = canonical(envelope);
  if (Buffer.byteLength(serialized) > MAX_ENVELOPE_BYTES) throw new Error('identity_registry_envelope_too_large');
  return serialized;
}

async function syncDirectory(directory) {
  // Windows does not support opening directories for fsync. File fsync still
  // protects every record; POSIX additionally persists the directory entry.
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusiveAtomic(destination, payload) {
  const directory = resolve(destination, '..');
  const temporary = join(directory, '.' + process.pid + '.' + randomUUID() + '.pending');
  let temporaryHandle;
  try {
    temporaryHandle = await open(temporary, 'wx', 0o600);
    await temporaryHandle.writeFile(payload, { encoding: 'utf8' });
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    await syncDirectory(directory);
    return true;
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function paths(rootDirectory, registryId, version) {
  if (!validRegistryId(registryId)) throw new Error('identity_registry_id_invalid');
  if (!validVersion(version)) throw new Error('identity_registry_version_invalid');
  const registryDirectory = join(rootDirectory, registryId);
  return {
    snapshot: join(registryDirectory, 'snapshots', version + '.json'),
    revocation: join(registryDirectory, 'revocations', version + '.json'),
  };
}

async function ensureRegistryDirectory(root, registryId, area) {
  const registryDirectory = join(root, registryId);
  const areaDirectory = join(registryDirectory, area);
  await mkdir(areaDirectory, { recursive: true, mode: 0o700 });
  // `mkdir({recursive:true})` can create each of these entries. On systems
  // with directory fsync, persist the whole path before reporting success.
  await syncDirectory(root);
  await syncDirectory(registryDirectory);
  await syncDirectory(areaDirectory);
  return areaDirectory;
}

async function readVerifiedRecord(path, expectedKind, registryId, version) {
  let handle;
  // A FIFO substituted at this path must not block a registry request before
  // fstat can reject it. The production contract refuses Windows entirely,
  // where this POSIX nonblocking open guarantee is unavailable.
  const flags = process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK;
  try { handle = await open(path, flags); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let raw;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_RECORD_BYTES) throw new Error('identity_registry_store_record_too_large');
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error('identity_registry_store_corrupt');
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size) throw new Error('identity_registry_store_integrity_failed');
    raw = bytes.toString('utf8');
  } finally { await handle.close(); }
  let record;
  try { record = JSON.parse(raw); } catch { throw new Error('identity_registry_store_corrupt'); }
  if (!record || Object.getPrototypeOf(record) !== Object.prototype || record.schema !== STORE_SCHEMA ||
    record.kind !== expectedKind || record.registry_id !== registryId || record.version !== version ||
    typeof record.payload !== 'string' || typeof record.payload_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.payload_sha256) || digest(record.payload) !== record.payload_sha256 ||
    raw !== canonical(record)) throw new Error('identity_registry_store_integrity_failed');
  return record;
}

/**
 * Returns the `IdentityRegistryConfig.snapshots` adapter plus an explicit
 * `revoke` operation for the deployment-owned revocation authority.
 */
export async function createIdentityRegistrySnapshotStore({ rootDirectory, allowNonDurableWindows = false }) {
  if (typeof rootDirectory !== 'string' || !isAbsolute(rootDirectory)) throw new Error('identity_registry_store_absolute_root_required');
  if (process.platform === 'win32' && !allowNonDurableWindows) {
    throw new Error('identity_registry_store_windows_durability_unproven');
  }
  const root = resolve(rootDirectory);
  let rootStats;
  try { rootStats = await stat(root); } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('identity_registry_store_preprovisioned_root_required');
    throw error;
  }
  if (!rootStats.isDirectory()) throw new Error('identity_registry_store_root_not_directory');

  async function publish({ registry_id: registryId, version, envelope }, { signal } = {}) {
    rejectAbort(signal);
    const payload = boundedEnvelope(envelope);
    const target = paths(root, registryId, version);
    await ensureRegistryDirectory(root, registryId, 'snapshots');
    rejectAbort(signal);
    // A revoked version can never be republished, even if its snapshot file
    // was deleted externally. Integrity failures remain fail closed.
    if (await readVerifiedRecord(target.revocation, 'revocation', registryId, version)) return false;
    const record = canonical({ schema: STORE_SCHEMA, kind: 'snapshot', registry_id: registryId, version,
      payload, payload_sha256: digest(payload) });
    const wrote = await writeExclusiveAtomic(target.snapshot, record);
    rejectAbort(signal);
    if (!wrote) {
      // Distinguish an ordinary immutable collision from a damaged existing
      // object. Both decline the write, but damaged state is never hidden.
      await readVerifiedRecord(target.snapshot, 'snapshot', registryId, version);
      return false;
    }
    // Read back the exact bytes after publication. A successful publish never
    // reports success for a corrupt or replaced durable record.
    const verified = await readVerifiedRecord(target.snapshot, 'snapshot', registryId, version);
    if (!verified || verified.payload !== payload) throw new Error('identity_registry_store_readback_failed');
    // A revoker may have won while this publisher was writing. Preserve the
    // immutable bytes for audit, but never acknowledge that version as active.
    if (await readVerifiedRecord(target.revocation, 'revocation', registryId, version)) return false;
    return true;
  }

  async function read({ registry_id: registryId, version }, { signal } = {}) {
    rejectAbort(signal);
    const target = paths(root, registryId, version);
    const revocation = await readVerifiedRecord(target.revocation, 'revocation', registryId, version);
    if (revocation) return { status: 'revoked' };
    const snapshot = await readVerifiedRecord(target.snapshot, 'snapshot', registryId, version);
    if (!snapshot) return { status: 'missing' };
    rejectAbort(signal);
    let envelope;
    try { envelope = JSON.parse(snapshot.payload); } catch { throw new Error('identity_registry_store_corrupt'); }
    // Recheck after the snapshot read so a revocation that completes while a
    // read is in flight is observed before this adapter returns an active pin.
    if (await readVerifiedRecord(target.revocation, 'revocation', registryId, version)) return { status: 'revoked' };
    return { status: 'active', envelope };
  }

  async function revoke({ registry_id: registryId, version, reason = 'deployment_revocation' }, { signal } = {}) {
    rejectAbort(signal);
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 240) throw new Error('identity_registry_revocation_reason_invalid');
    const target = paths(root, registryId, version);
    await ensureRegistryDirectory(root, registryId, 'revocations');
    const payload = canonical({ reason });
    const record = canonical({ schema: STORE_SCHEMA, kind: 'revocation', registry_id: registryId, version,
      payload, payload_sha256: digest(payload) });
    const wrote = await writeExclusiveAtomic(target.revocation, record);
    rejectAbort(signal);
    if (!wrote) {
      // A concurrent revoker must have produced a valid durable marker; any
      // corruption is an error rather than an ambiguous success.
      if (!await readVerifiedRecord(target.revocation, 'revocation', registryId, version)) throw new Error('identity_registry_revocation_readback_failed');
      return false;
    }
    if (!await readVerifiedRecord(target.revocation, 'revocation', registryId, version)) throw new Error('identity_registry_revocation_readback_failed');
    return true;
  }

  return Object.freeze({ publish, read, revoke, root_directory: root });
}

export const identityRegistrySnapshotStoreTest = Object.freeze({ canonical, digest, MAX_ENVELOPE_BYTES, MAX_RECORD_BYTES });

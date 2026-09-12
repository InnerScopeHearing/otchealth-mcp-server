import { createHash, createPublicKey, verify } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const LABEL = /^[a-z0-9][a-z0-9_.:-]{0,191}$/;
const VERSION = /^[^\s\p{C}]{1,1024}$/u;
const MAX = 256 * 1024;
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value as object).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value as object).sort().join('\0') === [...keys].sort().join('\0');
const text = (value: unknown, max = 240): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\s]/.test(value);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
type Reader = (request: { key: string; version_id?: string; sha256?: string }, options: { signal: AbortSignal }) => Promise<{ value: unknown; version_id: string }>;
type Run = { ref_version: string; run_id: string; purpose: string; scope: string; run_version: string; manifest_sha256: string };
type Authority = { schema: 'authenticated-structured-identity-authority-v1'; adapter_id: string; source_system: string; scope: 'cfo'|'clo'; version: string };
type Pin = { key: string; version_id: string; sha256: string };
export type IdentityRegistrySourceAuthorityConfig = {
  registryId: string; authority: Authority; run: Run; catalog: { catalog_version: string; catalog_sha256: string };
  partitionManifestVersion: string; publicKey: string | Buffer; manifest: Pin; pointer: { key: string };
  readJson: Reader; now?: () => number; timeoutMs?: number;
};

function validRun(run: unknown): run is Run {
  if (!exact(run, ['ref_version','run_id','purpose','scope','run_version','manifest_sha256'])) return false;
  const content = { ref_version: run.ref_version, purpose: run.purpose, scope: run.scope, run_version: run.run_version, manifest_sha256: run.manifest_sha256 };
  return run.ref_version === 'neptune-trial-active-run-ref-v1' && /^run_[a-f0-9]{64}$/.test(String(run.run_id)) && LABEL.test(String(run.purpose)) && run.scope === 'finance' && LABEL.test(String(run.run_version)) && HASH.test(String(run.manifest_sha256)) && run.run_id === 'run_' + hash(canonical(content));
}
function validAuthority(value: unknown): value is Authority { return exact(value, ['adapter_id','schema','scope','source_system','version']) && value.schema === 'authenticated-structured-identity-authority-v1' && ['cfo','clo'].includes(String(value.scope)) && text(value.adapter_id) && text(value.source_system) && text(value.version); }
function validPin(value: unknown): value is Pin { return exact(value, ['key','sha256','version_id']) && text(value.key, 1024) && HASH.test(String(value.sha256)) && VERSION.test(String(value.version_id)) && value.version_id !== 'null'; }
function validPageDescriptor(value: unknown): boolean { return exact(value, ['cursor','key','sha256','source_version','version_id']) && (value.cursor === null || text(value.cursor)) && text(value.key, 1024) && HASH.test(String(value.sha256)) && VERSION.test(String(value.version_id)) && value.version_id !== 'null' && text(value.source_version); }
function validShardDescriptor(value: unknown): boolean { return exact(value, ['key','registry_version','sha256','shard_id','source_version','version_id']) && text(value.key, 1024) && HASH.test(String(value.sha256)) && VERSION.test(String(value.version_id)) && value.version_id !== 'null' && text(value.shard_id) && text(value.registry_version) && text(value.source_version); }

/**
 * Adapts only a source-owner's explicit-ID, signed export. Catalog names and
 * graph lineage are checked as context, but are never converted into IDs here.
 */
export function createIdentityRegistrySourceAuthority(config: IdentityRegistrySourceAuthorityConfig) {
  const now = config.now ?? Date.now, timeoutMs = config.timeoutMs ?? 15_000;
  let coverageCache: { manifestVersion: string; hashes: ReadonlySet<string> } | undefined;
  if (!LABEL.test(config.registryId) || !validAuthority(config.authority) || !validRun(config.run) || !exact(config.catalog, ['catalog_sha256','catalog_version']) ||
      !text(config.catalog.catalog_version) || !HASH.test(config.catalog.catalog_sha256) || !/^sirm_[a-f0-9]{64}$/.test(config.partitionManifestVersion) ||
      !validPin(config.manifest) || !exact(config.pointer, ['key']) || !text(config.pointer.key, 1024) || typeof config.readJson !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 45_000) fail('identity_source_authority_configuration');
  const publicKey: ReturnType<typeof createPublicKey> = (() => { try { return createPublicKey(config.publicKey); } catch { return fail('identity_source_authority_configuration'); } })();
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('identity_source_authority_configuration');
  const keyHash = hash(Buffer.from(publicKey.export({ type: 'spki', format: 'der' })));
  async function call<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) fail('identity_source_authority_deadline'); const own = new AbortController(), combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
    let timer: ReturnType<typeof setTimeout> | undefined; let remove: () => void = () => {};
    const stop = new Promise<never>((_resolve, reject) => { const abort = () => reject(Object.assign(new Error('identity_source_authority_deadline'), { code: 'identity_source_authority_deadline' })); combined.addEventListener('abort', abort, { once: true }); remove = () => combined.removeEventListener('abort', abort); timer = setTimeout(() => own.abort(), timeoutMs); });
    try { const result = await Promise.race([Promise.resolve().then(() => work(combined)), stop]); if (combined.aborted) fail('identity_source_authority_deadline'); return result; }
    finally { if (timer) clearTimeout(timer); remove(); own.abort(); }
  }
  async function read(pin: Pin, signal?: AbortSignal) { const result = await call(s => config.readJson({ key: pin.key, version_id: pin.version_id, sha256: pin.sha256 }, { signal: s }), signal); if (!VERSION.test(result.version_id) || result.version_id !== pin.version_id) fail('identity_source_authority_corrupt'); return result.value; }
  function signed(value: unknown, validate: (snapshot: Record<string, unknown>) => boolean): Record<string, unknown> {
    if (!exact(value, ['signature','snapshot'])) fail('identity_source_authority_corrupt');
    const envelope = value as Record<string, unknown>;
    const signature = envelope.signature, snapshotValue = envelope.snapshot;
    if (typeof signature !== 'string' || !snapshotValue || typeof snapshotValue !== 'object' || Array.isArray(snapshotValue) || Buffer.byteLength(canonical(envelope), 'utf8') > MAX) fail('identity_source_authority_corrupt');
    const snapshot = snapshotValue as Record<string, unknown>, bytes = Buffer.from(signature as string, 'base64');
    if (bytes.length !== 64 || !validate(snapshot) || !verify(null, Buffer.from(canonical(snapshot)), publicKey, bytes)) fail('identity_source_authority_corrupt');
    return snapshot;
  }
  function manifest(value: unknown) { return signed(value, snapshot => { const pages = snapshot.pages, coverage = snapshot.coverage_pages, shards = snapshot.shards; return exact(snapshot, ['catalog','coverage_binding_count','coverage_binding_sha256','coverage_pages','pages','partition_manifest_version','public_key_sha256','registry_id','run','schema','shards','source_authority','source_generation','version']) && snapshot.schema === 'source-identity-registry-explicit-export-manifest-v1' && snapshot.registry_id === config.registryId && same(snapshot.source_authority, config.authority) && same(snapshot.run, config.run) && same(snapshot.catalog, config.catalog) && snapshot.partition_manifest_version === config.partitionManifestVersion && snapshot.public_key_sha256 === keyHash && text(snapshot.source_generation) && Number.isSafeInteger(snapshot.coverage_binding_count) && Number(snapshot.coverage_binding_count) >= 0 && Number(snapshot.coverage_binding_count) <= 100_000 && HASH.test(String(snapshot.coverage_binding_sha256)) && Array.isArray(pages) && pages.length > 0 && pages.length <= 1000 && pages.every(validPageDescriptor) && new Set(pages.map(page => canonical([page.cursor, page.source_version]))).size === pages.length && Array.isArray(coverage) && coverage.length > 0 && coverage.length <= 100 && coverage.every(validPageDescriptor) && new Set(coverage.map(page => canonical(page.cursor))).size === coverage.length && Array.isArray(shards) && shards.length > 0 && shards.length <= 1000 && shards.every(validShardDescriptor) && new Set(shards.map(shard => shard.shard_id)).size === shards.length && snapshot.version === 'siex_' + hash(canonical({ registry_id: snapshot.registry_id, source_authority: snapshot.source_authority, run: snapshot.run, catalog: snapshot.catalog, partition_manifest_version: snapshot.partition_manifest_version, source_generation: snapshot.source_generation, pages, coverage_pages: coverage, shards, coverage_binding_count: snapshot.coverage_binding_count, coverage_binding_sha256: snapshot.coverage_binding_sha256, public_key_sha256: snapshot.public_key_sha256 })); }); }
  async function current(m: Record<string, unknown>, signal?: AbortSignal) {
    const value = await call(s => config.readJson({ key: config.pointer.key }, { signal: s }), signal);
    const pointer = signed(value.value, snapshot => exact(snapshot, ['expires_at','manifest_version','registry_id','revoked','schema','source_generation']) && snapshot.schema === 'source-identity-registry-explicit-export-current-v1' && snapshot.registry_id === config.registryId && snapshot.manifest_version === m.version && snapshot.source_generation === m.source_generation && snapshot.revoked === false && typeof snapshot.expires_at === 'string' && Number.isFinite(Date.parse(snapshot.expires_at)) && Date.parse(snapshot.expires_at) > now() + 1000);
    return pointer;
  }
  async function loaded(signal?: AbortSignal) { const m = manifest(await read(config.manifest, signal)); await current(m, signal); return m; }
  function pageValue(value: unknown, descriptor: Record<string, unknown>) {
    if (!exact(value, ['authority','current','next_cursor','records','schema','source_version']) || value.schema !== 'structured-identity-source-page-v1' || value.current !== true || !same(value.authority, config.authority) || value.source_version !== descriptor.source_version || !Array.isArray(value.records) || value.records.length > 1000 || (value.next_cursor !== null && !text(value.next_cursor))) fail('identity_source_authority_corrupt');
    return value as Record<string, unknown>;
  }
  async function sourcePage(request: { cursor: string | null; source_version: string | null; page_size: number }, options: { signal?: AbortSignal } = {}) {
    if (!(request.cursor === null || text(request.cursor)) || !(request.source_version === null || text(request.source_version)) || !Number.isSafeInteger(request.page_size) || request.page_size < 1 || request.page_size > 100) fail('identity_source_authority_request_invalid');
    const m = await loaded(options.signal), found = (m.pages as Record<string, unknown>[]).find(item => item.cursor === request.cursor && (request.source_version === null || item.source_version === request.source_version)); if (!found) fail('identity_source_authority_unavailable'); const descriptor = found as Record<string, unknown>;
    const value = pageValue(await read(descriptor as Pin, options.signal), descriptor); if ((value.records as unknown[]).length > request.page_size) fail('identity_source_authority_corrupt'); await current(m, options.signal); return structuredClone(value);
  }
  async function sourceCurrent(request: { source_version: string }, options: { signal?: AbortSignal } = {}) { if (!text(request.source_version)) fail('identity_source_authority_request_invalid'); const m = await loaded(options.signal); if (!(m.pages as Record<string, unknown>[]).some(page => page.source_version === request.source_version)) return false; await current(m, options.signal); return true; }
  async function manifestCurrent(request: { registry_id: string; manifest_version: string; source_generation: string }, options: { signal?: AbortSignal } = {}) { const m = await loaded(options.signal); const yes = request.registry_id === config.registryId && request.manifest_version === config.partitionManifestVersion && request.source_generation === m.source_generation; await current(m, options.signal); return yes; }
  async function shardCurrent(request: { registry_id: string; manifest_version: string; shard_id: string; registry_version: string; source_version: string }, options: { signal?: AbortSignal } = {}) { const m = await loaded(options.signal); if (request.registry_id !== config.registryId || request.manifest_version !== config.partitionManifestVersion || !text(request.shard_id) || !text(request.registry_version) || !text(request.source_version)) return false; const d = (m.shards as Record<string, unknown>[]).find(shard => shard.shard_id === request.shard_id); if (!d || d.registry_version !== request.registry_version || d.source_version !== request.source_version) return false; const value = await read(d as Pin, options.signal); if (!exact(value, ['current','partition_manifest_version','registry_id','registry_version','schema','shard_id','source_generation','source_version']) || value.schema !== 'source-identity-registry-explicit-export-shard-current-v1' || value.current !== true || value.registry_id !== config.registryId || value.partition_manifest_version !== config.partitionManifestVersion || value.shard_id !== request.shard_id || value.registry_version !== request.registry_version || value.source_version !== request.source_version || value.source_generation !== m.source_generation) fail('identity_source_authority_corrupt'); await current(m, options.signal); return true; }
  function coverageValue(value: unknown, m: Record<string, unknown>, pageSize: number) {
    if (!exact(value, ['binding_hashes','catalog_version','coverage_sha256','next_cursor','schema','source_generation']) || value.schema !== 'source-identity-catalog-coverage-page-v1' || value.catalog_version !== config.catalog.catalog_version || value.coverage_sha256 !== config.catalog.catalog_sha256 || value.source_generation !== m.source_generation || !Array.isArray(value.binding_hashes) || value.binding_hashes.length > pageSize || value.binding_hashes.some(item => !HASH.test(String(item))) || (value.next_cursor !== null && !text(value.next_cursor))) fail('identity_source_authority_corrupt');
    return value as Record<string, unknown>;
  }
  function validCoverageRequest(request: { registry_id: string; manifest_version: string; source_generation: string; catalog_version: string; coverage_sha256: string }) {
    return request.registry_id === config.registryId && request.manifest_version === config.partitionManifestVersion && request.catalog_version === config.catalog.catalog_version && request.coverage_sha256 === config.catalog.catalog_sha256;
  }
  async function coveragePage(request: { registry_id: string; manifest_version: string; source_generation: string; catalog_version: string; coverage_sha256: string; cursor: string | null; page_size: number }, options: { signal?: AbortSignal } = {}) { if (!(request.cursor === null || text(request.cursor)) || !Number.isSafeInteger(request.page_size) || request.page_size < 1 || request.page_size > 1000) fail('identity_source_authority_request_invalid'); const m = await loaded(options.signal); if (!validCoverageRequest(request) || request.source_generation !== m.source_generation) fail('identity_source_authority_request_invalid'); const d = (m.coverage_pages as Record<string, unknown>[]).find(page => page.cursor === request.cursor); if (!d) fail('identity_source_authority_unavailable'); const value = coverageValue(await read(d as Pin, options.signal), m, request.page_size); await current(m, options.signal); return structuredClone(value); }
  async function bindingCovered(request: { registry_id: string; manifest_version: string; source_generation: string; catalog_version: string; coverage_sha256: string; source_binding_hash: string }, options: { signal?: AbortSignal } = {}): Promise<boolean> { if (!HASH.test(request.source_binding_hash)) return false; const m = await loaded(options.signal); if (!validCoverageRequest(request) || request.source_generation !== m.source_generation) return false; const manifestVersion = String(m.version); let hashes = coverageCache?.manifestVersion === manifestVersion ? coverageCache.hashes : undefined; if (!hashes) { const pages = m.coverage_pages as Record<string, unknown>[], all: string[] = []; for (let index = 0; index < pages.length; index++) { const page = coverageValue(await read(pages[index] as Pin, options.signal), m, 1000); if (page.next_cursor !== (pages[index + 1]?.cursor ?? null)) fail('identity_source_authority_corrupt'); all.push(...page.binding_hashes as string[]); } const unique = [...new Set(all)].sort(); if (unique.length !== all.length || unique.length !== m.coverage_binding_count || hash(canonical(unique)) !== m.coverage_binding_sha256) fail('identity_source_authority_corrupt'); await current(m, options.signal); hashes = new Set(unique); coverageCache = { manifestVersion, hashes }; } else await current(m, options.signal); return hashes.has(request.source_binding_hash); }
  return Object.freeze({ source: Object.freeze({ page: sourcePage, current: sourceCurrent }), partitions: Object.freeze({ manifest_current: manifestCurrent, shard_current: shardCurrent, binding_covered: bindingCovered, coverage_page: coveragePage }) });
}

import { createHash } from 'node:crypto';
import type { AuthContext } from '../auth/bearer.js';
import type { IdentityRegistryConfig, IdentityRegistryResolver } from './graph-worker-broker.js';
import { identityRegistryVerification } from './identity-registry-verification.js';
import { createProductionIdentityRegistryResolver } from './identity-registry-production.js';
import { parseIdentityCurrentnessPointer } from './relationship-query/identity-currentness-proof.mjs';

type Json = Record<string, any>;
const SHA = /^[a-f0-9]{64}$/;
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) :
  Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value as Json).sort()
    .map(key => JSON.stringify(key) + ':' + canonical((value as Json)[key])).join(',') + '}';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 1200 && !value.includes('\0');

export type RelationshipIdentityCurrentnessResolver = Readonly<{
  revalidate: (request: unknown, previousProof: unknown, caller: AuthContext,
    options: { signal: AbortSignal }) => Promise<Record<string, unknown> | null>;
}>;

function requestIdentity(request: unknown) {
  const row = request as Json, binding = row?.evidence?.source_binding, side = row?.side;
  const mention = side === 'subject' || side === 'object' ? row?.candidate?.[side] : null;
  const endpoint = row?.endpoint, identifier = endpoint?.identifier;
  if (!row || !text(binding?.source_document_version) || !SHA.test(binding?.chunk_sha256 ?? '') || !text(mention) ||
      endpoint?.display_name !== mention || !text(endpoint?.entity_type) || !text(identifier?.namespace) ||
      !text(identifier?.scope) || !text(identifier?.value) || !text(row.entity_id)) return null;
  const entityId = 'entity_' + digest(canonical({ entity_type: endpoint.entity_type, namespace: identifier.namespace,
    scope: identifier.scope, value: identifier.value }));
  return entityId === row.entity_id ? { binding, mention, endpoint } : null;
}

function matchingEntry(snapshot: Json, identity: NonNullable<ReturnType<typeof requestIdentity>>, entrySha256: string) {
  const key = (row: Json) => row?.source_document_version === identity.binding.source_document_version &&
    row?.source_sha256 === identity.binding.chunk_sha256 && row?.mention === identity.mention;
  if (!Array.isArray(snapshot.entries) || !Array.isArray(snapshot.revocations) || snapshot.revocations.some(key)) return null;
  const matches = snapshot.entries.filter(key);
  return matches.length === 1 && same(matches[0].endpoint, identity.endpoint) && digest(canonical(matches[0])) === entrySha256
    ? matches[0] : null;
}

async function snapshotCurrent(config: IdentityRegistryConfig, pointer: Json,
  identity: NonNullable<ReturnType<typeof requestIdentity>>, signal: AbortSignal) {
  const first = await config.snapshots.read({ registry_id: pointer.registry_id, version: pointer.registry_version }, { signal });
  if (first.status !== 'active' || !identityRegistryVerification.validIdentityEnvelope(first.envelope, config, pointer.registry_version)) return false;
  const envelope = first.envelope as Json, snapshot = envelope.snapshot as Json;
  if (snapshot.public_key_sha256 !== pointer.public_key_sha256 || digest(canonical(snapshot)) !== pointer.snapshot_sha256 ||
      !matchingEntry(snapshot, identity, pointer.entry_sha256) ||
      await config.source.current({ source_version: snapshot.source_version }, { signal }) !== true) return false;
  const second = await config.snapshots.read({ registry_id: pointer.registry_id, version: pointer.registry_version }, { signal });
  return second.status === 'active' && same(second.envelope, first.envelope) &&
    await config.source.current({ source_version: snapshot.source_version }, { signal }) === true;
}

async function partitionCurrent(config: IdentityRegistryConfig, pointer: Json,
  identity: NonNullable<ReturnType<typeof requestIdentity>>, signal: AbortSignal) {
  const partitions = config.partitions;
  if (!partitions || partitions.manifest_version !== pointer.manifest_version) return false;
  const storedManifest = await partitions.read_manifest({ registry_id: pointer.registry_id,
    manifest_version: pointer.manifest_version }, { signal });
  if (storedManifest.status !== 'active' ||
      !identityRegistryVerification.validPartitionManifest(storedManifest.envelope, config, pointer.manifest_version)) return false;
  const manifest = (storedManifest.envelope as Json).snapshot as Json;
  if (digest(canonical(manifest)) !== pointer.manifest_sha256 || manifest.public_key_sha256 !== pointer.public_key_sha256 ||
      await partitions.manifest_current({ registry_id: pointer.registry_id, manifest_version: pointer.manifest_version,
        source_generation: manifest.source_generation }, { signal }) !== true) return false;
  const descriptor = (manifest.shards as Json[]).find(item => item.shard_id === pointer.shard_id);
  if (!descriptor || descriptor.snapshot_sha256 !== pointer.snapshot_sha256) return false;
  const shardRequest = { registry_id: pointer.registry_id, manifest_version: pointer.manifest_version,
    shard_id: pointer.shard_id, registry_version: descriptor.registry_version,
    source_version: descriptor.source_version };
  if (await partitions.shard_current(shardRequest, { signal }) !== true) return false;
  const storedShard = await partitions.read_shard(shardRequest, { signal });
  if (storedShard.status !== 'active' ||
      !identityRegistryVerification.validPartitionShard(storedShard.envelope, config, manifest, descriptor)) return false;
  const snapshot = (storedShard.envelope as Json).snapshot as Json;
  const bindingHash = digest(canonical({ source_document_version: identity.binding.source_document_version,
    source_sha256: identity.binding.chunk_sha256 }));
  const coverage = manifest.catalog_coverage as Json;
  const coverageRequest = { registry_id: pointer.registry_id,
    manifest_version: pointer.manifest_version, source_generation: manifest.source_generation,
    catalog_version: coverage.catalog_version, coverage_sha256: coverage.coverage_sha256,
    source_binding_hash: bindingHash };
  const covered = await partitions.binding_covered(coverageRequest, { signal });
  if (covered !== true || !matchingEntry(snapshot, identity, pointer.entry_sha256)) return false;
  const secondManifest = await partitions.read_manifest({ registry_id: pointer.registry_id,
    manifest_version: pointer.manifest_version }, { signal });
  if (secondManifest.status !== 'active' || !same(secondManifest.envelope, storedManifest.envelope) ||
      !identityRegistryVerification.validPartitionManifest(secondManifest.envelope, config, pointer.manifest_version)) return false;
  const secondShard = await partitions.read_shard(shardRequest, { signal });
  if (secondShard.status !== 'active' || !same(secondShard.envelope, storedShard.envelope) ||
      !identityRegistryVerification.validPartitionShard(secondShard.envelope, config, manifest, descriptor) ||
      !matchingEntry((secondShard.envelope as Json).snapshot as Json, identity, pointer.entry_sha256)) return false;
  return await partitions.binding_covered(coverageRequest, { signal }) === true &&
    await partitions.shard_current(shardRequest, { signal }) === true &&
    await partitions.manifest_current({ registry_id: pointer.registry_id, manifest_version: pointer.manifest_version,
      source_generation: manifest.source_generation }, { signal }) === true;
}

export function createRelationshipIdentityCurrentnessResolver(
  registry: IdentityRegistryResolver | undefined,
): RelationshipIdentityCurrentnessResolver | undefined {
  if (!registry) return undefined;
  return Object.freeze({
    async revalidate(request, previousProof, caller, { signal }) {
      try {
        if (signal.aborted || !['cfo','clo'].includes(caller.caller_agent)) return null;
        const proof = previousProof as Json, requestSha256 = digest(canonical(request));
        if (proof?.verified !== true || proof.request_sha256 !== requestSha256) return null;
        const pointer = parseIdentityCurrentnessPointer(proof.identity_currentness, requestSha256) as Json | null;
        const identity = requestIdentity(request);
        if (!pointer || !identity) return null;
        const config = await registry.resolve({ registry_id: pointer.registry_id, caller }, { signal });
        if (!config || config.registry_id !== pointer.registry_id || signal.aborted) return null;
        const current = pointer.mode === 'snapshot' ? await snapshotCurrent(config, pointer, identity, signal) :
          await partitionCurrent(config, pointer, identity, signal);
        return current && !signal.aborted ? structuredClone(proof) : null;
      } catch { return null; }
    },
  });
}

export function createProductionRelationshipIdentityCurrentnessResolver(
  raw: string | undefined = process.env.GRAPH_IDENTITY_REGISTRY_CONFIG_JSON,
) {
  return createRelationshipIdentityCurrentnessResolver(createProductionIdentityRegistryResolver(raw));
}

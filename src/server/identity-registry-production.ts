import type { IdentityRegistryResolver } from './graph-worker-broker.js';
import { parseIdentityRegistryProductionConfig } from './identity-registry-production-config.js';
import { createIdentityRegistrySourceReader } from './identity-registry-source-reader.js';
import { createIdentityRegistrySourceAuthority } from './identity-registry-source-authority.js';
import { createRuntimeIdentityRegistryS3SnapshotStore } from './identity-registry-s3-runtime.js';

/** Normal server startup uses this composition. Missing configuration stays unavailable. */
export function createProductionIdentityRegistryResolver(
  raw: string | undefined = process.env.GRAPH_IDENTITY_REGISTRY_CONFIG_JSON,
): IdentityRegistryResolver | undefined {
  const config = parseIdentityRegistryProductionConfig(raw);
  if (!config) return undefined;
  const readJson = createIdentityRegistrySourceReader({ prefix: config.source.prefix });
  const authority = createIdentityRegistrySourceAuthority({
    registryId: config.registry_id, authority: config.authority, run: config.binding.run,
    catalog: config.source.catalog, publicKey: config.public_key,
    partitionManifestVersion: config.partition_manifest_version,
    manifest: config.source.manifest, pointer: config.source.pointer, readJson,
    now: () => Date.now(), timeoutMs: 10_000,
  });
  const storage = createRuntimeIdentityRegistryS3SnapshotStore({
    bucket: 'otchealth-finance-legal-dr-55c84f6b', region: 'us-east-1',
    prefix: config.storage.prefix,
    approvedPolicyCanonicalSha256: config.storage.approved_policy_canonical_sha256,
    approvedStorageScopeSha256: config.storage.approved_storage_scope_sha256,
    sse: config.storage.sse, requestTimeoutMs: 10_000,
  });
  return {
    async resolve({ registry_id, caller }, { signal }) {
      if (caller.caller_agent !== 'cfo' || registry_id !== config.registry_id || signal.aborted) return null;
      await storage.preflight(signal);
      if (signal.aborted) return null;
      const snapshots = storage.snapshots;
      return {
        registry_id, authority: config.authority, binding: config.binding,
        public_key: config.public_key, source: authority.source, snapshots,
        partitions: {
          ...authority.partitions, manifest_version: config.partition_manifest_version,
          read_manifest: (request, options) => snapshots.read({ registry_id: request.registry_id, version: request.manifest_version }, options),
          read_shard: (request, options) => snapshots.read({ registry_id: request.registry_id, version: request.registry_version }, options),
          publish_manifest: (request, options) => snapshots.publish({ registry_id: request.registry_id,
            version: request.manifest_version, envelope: request.envelope }, options),
          publish_shard: (request, options) => snapshots.publish({ registry_id: request.registry_id,
            version: request.registry_version, envelope: request.envelope }, options),
        },
      };
    },
  };
}

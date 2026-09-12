# CFO source-owned explicit-ID export pilot

`publishExplicitIdentityRegistryExport` is the source-owner publication primitive. `tools/identity-registry-explicit-export-run.mjs` is its approved source-ring runner. It takes an explicit-ID input path, a public ports-config path, and a new output path. It never prints or copies the input records.

The runner constructs these two concrete approved ports:

- `createCfoIdentityRegistryKmsSigner`, which uses the existing ECS SigV4 credential resolver to call KMS `GetPublicKey` and `Sign` with an Ed25519 KMS key reference. KMS retains the private key. The runner accepts no private key, key file, key environment variable, or signing-key value.
- `createExplicitExportImmutableStore`, which uses the existing identity-registry S3 runtime, including Versioning and reviewed immutable-prefix policy preflight. It writes encrypted, versioned objects with `If-None-Match: *`, then reads the exact assigned version. An interrupted or repeated write is accepted only when the existing bytes are identical.

The ports config is public metadata only:

```json
{
  "schema": "cfo-identity-registry-explicit-export-ports-v1",
  "kms": { "region": "us-east-1", "key_id": "arn:aws:kms:us-east-1:900915535335:key/<new-dedicated-key-id>" },
  "source_storage": {
    "bucket": "otchealth-finance-legal-dr-55c84f6b",
    "region": "us-east-1",
    "prefix": "graph-trial/cfo-identity-pilot",
    "approved_policy_canonical_sha256": "<64 lowercase hex>",
    "approved_storage_scope_sha256": "<64 lowercase hex>",
    "sse": { "algorithm": "AES256" }
  }
}
```

The example identifiers above are placeholders, not a deployed configuration. The KMS reference must be the immutable dedicated key ARN, never a mutable alias. Source owner supplies actual approved metadata in its own ring. No bucket, KMS key, policy, source record, or gateway deployment is provisioned by this change.

The input is `source-identity-registry-explicit-export-input-v1` in practice, enforced by exact field validation. It carries one CFO registry identifier, source authority descriptor, exact active run, catalog pins, partition-manifest version, source generation and version, output prefix, expiry, prepared source bindings, explicit identity records, and current partition shard versions.

Each binding contains only `source_document_version` and `chunk_sha256`. Its coverage key is the canonical SHA-256 of `{source_document_version, source_sha256: chunk_sha256}`. The exporter rejects duplicate bindings and rejects every identity record whose document version and source hash do not match one supplied binding.

Resolved records require a source-native `source_record_id`, source document version and SHA-256, mention, and `endpoint.identifier` namespace, scope, and value. The exporter rejects name-only records before it calls the storage port. It accepts the existing explicit unresolved and revoked record forms, so ambiguity remains unresolved and revoked identities remain revocable.

The workflow writes, in order, immutable source pages, coverage pages, per-shard current records, a signed manifest, and a signed current pointer. The manifest pins every preceding object key, assigned version ID, and SHA-256. The returned receipt has only registry, generation, count, digest, key fingerprint, and object-pin metadata. `public_config` is the source half of `identity-registry-production-v1` and contains only the Ed25519 public key. The release owner later supplies the separate storage-policy section.

Run the synthetic proof from the gateway checkout:

```powershell
node .\node_modules\typescript\bin\tsc -p tsconfig.json; node --test tools\identity-registry-explicit-export.test.mjs; node --import ./tools/relationship-artifacts/typescript-test-loader.mjs --test src/server/identity-registry-explicit-export-ports.test.ts
```

This proof uses generated synthetic records and an in-memory immutable store. It does not read CFO source data, write cloud storage, use a production signing key, or configure the gateway.

After source owner has supplied approved metadata in its ring, the bounded runner command is:

```powershell
node .\tools\identity-registry-explicit-export-run.mjs --input C:\approved-source-ring\identity-export-input.json --ports C:\approved-source-ring\identity-export-ports.json --output C:\approved-source-ring\identity-export-result.json
```

The output has the public production-config source fields and immutable object pins. The release owner adds the separate storage section to `identity-registry-production-v1`, runs preflight, and deploys only after the documented live acceptance checks.

## Proposed bootstrap, pending CTO review

The CFO prerequisites receipt dated 2026-09-12 confirms that the existing finance source bucket is not an approved registry destination, and that no compatible signer, source-native export, or registry prefix was discovered. This proposal creates those resources only after review. It does not reuse unrelated RSA or application signing references.

| Resource | Proposed public reference | Required control |
| --- | --- | --- |
| Source export prefix | `graph-trial/20260912/identity-registry/cfo-pilot/source` | Dedicated versioned source prefix, disjoint from existing CFO source and worker prefixes. |
| Registry snapshots prefix | `graph-trial/20260912/identity-registry/cfo-pilot/snapshots` | Separate prefix for gateway partition and relationship snapshots. |
| Signer | New asymmetric KMS key, `ECC_NIST_EDWARDS25519`, `SIGN_VERIFY` | Pin the generated key ARN in public config. The exporter role receives only `kms:GetPublicKey` and `kms:Sign` constrained to `ED25519_SHA_512`. |
| Source owner bridge | New CFO source-ring scheduled job | It fetches source-native records from the approved source system, emits an explicit namespace/scope/value only when the source supplies all three fields, and marks every other record unresolved. It calculates the version/hash binding before calling the runner. |

The first run is intentionally one native opaque identifier, one prepared binding, and one shard. The runner limits the pilot to 100 records and bindings, one page each, one shard, 128-byte object-version IDs, and a 4096-byte manifest or pointer signing payload. It computes the worst-case manifest size before any storage write. A larger rollout needs a separately reviewed signed-digest envelope contract before increasing those limits.

Provisioning review must approve the exact S3 policy and its canonical hash, the scope hash, KMS key policy, source-owner task role, lifecycle and recovery controls, and the bridge’s native source endpoint. The code does not create any of them. The public result contains only the generated KMS public SPKI, object pins, and production configuration fields.

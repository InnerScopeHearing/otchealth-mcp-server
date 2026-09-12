# CFO source-owned explicit-ID export pilot

`publishExplicitIdentityRegistryExport` is the source-owner publication primitive. `tools/identity-registry-explicit-export-run.mjs` is its approved source-ring runner. It takes an explicit-ID input path, a public ports-config path, and a new output path. It never prints or copies the input records.

The runner constructs these two concrete approved ports:

- `createCfoIdentityRegistryKmsSigner`, which uses the existing ECS SigV4 credential resolver to call KMS `GetPublicKey` and `Sign` with an Ed25519 KMS key reference. KMS retains the private key. The runner accepts no private key, key file, key environment variable, or signing-key value.
- `createExplicitExportImmutableStore`, which uses the existing identity-registry S3 runtime, including Versioning and reviewed immutable-prefix policy preflight. It writes encrypted, versioned objects with `If-None-Match: *`, then reads the exact assigned version. An interrupted or repeated write is accepted only when the existing bytes are identical.

The ports config is public metadata only:

```json
{
  "schema": "cfo-identity-registry-explicit-export-ports-v1",
  "kms": { "region": "us-east-1", "key_id": "alias/cfo-identity-registry-pilot" },
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

The example identifiers above are placeholders, not a deployed configuration. Source owner supplies actual approved metadata in its own ring. No bucket, KMS key, policy, source record, or gateway deployment is provisioned by this change.

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

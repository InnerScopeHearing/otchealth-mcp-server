# CFO source-owned explicit-ID export pilot

`publishExplicitIdentityRegistryExport` is the source-owner publication primitive. It is intentionally a module rather than a credential-loading CLI. The CFO process supplies two approved ports:

- `signer`, with a public Ed25519 PEM and `sign(bytes)`. The signer reads the private key inside the authorized secrets-store boundary and returns only a 64-byte signature. The exporter never accepts a private key, a key file, a key environment variable, or a signing-key value.
- `store.putImmutable({ key, body })`, which writes an encrypted, versioned object with conditional creation and returns its assigned version ID. The exporter does not select a cloud provider or create a bucket.

The input is `source-identity-registry-explicit-export-input-v1` in practice, enforced by exact field validation. It carries one CFO registry identifier, source authority descriptor, exact active run, catalog pins, partition-manifest version, source generation and version, output prefix, expiry, prepared source bindings, explicit identity records, and current partition shard versions.

Each binding contains only `source_document_version` and `chunk_sha256`. Its coverage key is the canonical SHA-256 of `{source_document_version, source_sha256: chunk_sha256}`. The exporter rejects duplicate bindings and rejects every identity record whose document version and source hash do not match one supplied binding.

Resolved records require a source-native `source_record_id`, source document version and SHA-256, mention, and `endpoint.identifier` namespace, scope, and value. The exporter rejects name-only records before it calls the storage port. It accepts the existing explicit unresolved and revoked record forms, so ambiguity remains unresolved and revoked identities remain revocable.

The workflow writes, in order, immutable source pages, coverage pages, per-shard current records, a signed manifest, and a signed current pointer. The manifest pins every preceding object key, assigned version ID, and SHA-256. The returned receipt has only registry, generation, count, digest, key fingerprint, and object-pin metadata. `public_config` is the source half of `identity-registry-production-v1` and contains only the Ed25519 public key. The release owner later supplies the separate storage-policy section.

Run the synthetic proof from the gateway checkout:

```powershell
node .\node_modules\typescript\bin\tsc -p tsconfig.json; node --test tools\identity-registry-explicit-export.test.mjs
```

This proof uses generated synthetic records and an in-memory immutable store. It does not read CFO source data, write cloud storage, use a production signing key, or configure the gateway.

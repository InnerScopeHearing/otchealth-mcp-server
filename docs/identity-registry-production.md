# Configured identity registry startup

Normal gateway startup now constructs the identity registry from `GRAPH_IDENTITY_REGISTRY_CONFIG_JSON`. An absent value leaves identity routes unavailable. Malformed configuration fails startup with a generic error that does not echo configuration values. This change does not enable a source, provision storage, create identities, generate a production signing key, or start a backfill.

The configuration contract is `identity-registry-production-v1`, validated in `src/server/identity-registry-production-config.ts`. It binds one CFO registry to one finance run, source authority, catalog version/hash, signed partition manifest pin, and Ed25519 public key. It supplies separate source and registry-storage prefixes under `graph-trial/`. S3 requests are confined to the existing finance bucket in us-east-1. No private key enters the gateway.

## Source-owned authority

The source owner must produce an immutable, signed `source-identity-registry-explicit-export-manifest-v1` export from explicit structured identifiers. Document names, catalog associations, model candidates, and inferred name matches are not identity authority. Existing catalog/text materialization alone cannot supply this export.

The export pins the exact object version and SHA-256 of each source page, coverage page, and shard authority record. A separately signed current pointer identifies the active export and generation and carries expiry/revocation state. Reads check current authority before and after I/O. Source object responses must be versioned, encrypted, bounded, and match their declared content length and exact pinned bytes. Missing, expired, revoked, corrupted, or changed authority fails closed.

Coverage includes a signed expected binding count and sorted-set SHA-256. Membership requires reconciliation of the declared coverage stream. A signed export is still a source-owner assertion: deployment acceptance must independently establish that its source catalog covers the intended corpus. No synthetic count is a company document census.

## Storage policy evidence

Runtime storage uses the same receipt and version-pinned snapshot algorithm as the existing tested S3 store. Every storage operation first reads bucket versioning and the bucket policy. It requires Versioning Enabled, the exact reviewed canonical policy hash, and a scope digest:

`sha256(canonical({bucket, prefix, policy_sha256}))`

The policy must include an unconditional Deny for both object deletion and version deletion, applying to Principal `*` at the exact registry prefix, and a Deny for PutObject when `s3:if-none-match` is absent. Unsupported equivalent policy forms are rejected for review instead of guessed equivalent. Conditional-create enforcement follows the [AWS S3 policy contract](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html).

The configured policy hash is review evidence, not proof of all storage durability. Deployment must additionally verify retention/lifecycle settings, effective IAM, encryption/KMS permissions, source-owner write ownership, and recovery. The runtime rejects policy changes but cannot make a bucket administrator unable to change policy. No AWS policy or lifecycle was changed by the synthetic verification.

## Validation and activation

`node tools/relationship-artifacts/production-registry-wire.mjs` runs against the compiled normal factory. It uses synthetic source-owned signed exports, the production SigV4 signer, actual gateway source-page routes, and the runtime S3 receipt store. It verifies malformed records and revoked source authority are denied, a recreated replica reads pinned data, and changed policy blocks access. It makes zero AWS calls and does not prove a process restart or a deployment.

Production acceptance still requires the real source-owner export and signer reference, public-key/manifest/catalog/run pins, reviewed policy/scope hashes, S3 retention and permission evidence, and ECS configuration installed by the release owner. Then verify the deployed revision, an independently authenticated source read, full source-owned coverage, and fresh-session relationship retrieval. Keep Graph inactive until those checks pass. Memory/evaluator releases can proceed independently.

# Immutable relationship artifact transport

This draft implements the missing artifact HTTP transport and an explicit client mapping. It does not activate a producer, admit a cohort, change IAM, deploy the gateway or provision graph infrastructure. PR316 and CTO PR190 release holds remain unchanged.

## Exact sources

- Gateway base: published PR319, `e4ba13ee62155a56a8556bfcb211579a79081105`, branch `claude/catalog-gateway-20260908`.
- The initially inspected local catalog commit `cb5d03ad74bf8e3d8b0acac137d6d2aedd832f5a` has the same tree as that published base. This branch was aligned to the published commit before implementation.
- Existing CTO store, durable workflow and synthetic fixture used for cross-repository acceptance: CTO PR191 source `4cd6a6e9b42c6714ccfd5f9b3749ed42a3e5c9e1`. Its persisted-5xx reconciliation fix is included.
- New branch: `claude/relationship-artifact-gateway-20260908`. The draft PR head identifies the delivered commit.

## Gateway contract

`GET` and `PUT /relationship-artifacts/v1/:runId/:producerId/sha256/:shard/:digest.json` map to the fixed bucket `otchealth-finance-legal-dr-55c84f6b`, region `us-east-1`, and key `graph-trial/20260908/workers/cfo/<run>/relationship-producers/<producer>/resolution-artifacts/sha256/<shard>/<digest>.json`.

`GRAPH_RELATIONSHIP_ARTIFACT_POLICY_JSON` defaults to empty. Trusted configuration requires exact fields `schema`, `policy_version`, `expires_at`, and `bindings`. Schema is `relationship-artifact-policy-v1`; expiry is canonical ISO UTC. Each binding has exact fields `authenticated_caller`, `caller_hash`, `producer_id`, `run`, and `encryption`. Caller must be CFO; caller hash must match the authenticated connector fingerprint. Producer syntax is `^[a-z][a-z0-9-]{0,63}$`. Run is the complete validated finance active-run reference. Encryption is `{algorithm:"AES256"}` or `{algorithm:"aws:kms",kms_key_id:<approved key identifier>}`. Configuration contains identifiers, never credential values. Duplicate bindings are refused.

Every operation requires both this producer policy and the catalog controller's fresh CFO cohort binding for the exact run. The active-run registry must also remain active. Policy, cohort and active-run checks run before and after artifact I/O, followed by connector reauthentication. This route neither accepts a caller-supplied cohort receipt nor creates admissions. Catalog authority is run-scoped; producer authority comes separately from the trusted credential-fingerprint binding.

PUT requires `Content-Type: application/json` and `If-None-Match: *`; `If-Match` and query strings are refused. The server fixes encryption and run/producer metadata. The envelope is exactly `{schema:"relationship-resolution-artifact-v1",payload_sha256,payload}`. The payload hash must match the URL and shard. Only complete `resolution-source-input-v1` and CFO `resolution-history-v1` artifacts for the configured run are accepted. Canonical payload bytes are limited to 16 MiB and JSON depth to 128. The route-local wire limit is 16 MiB plus 1024 bytes; the ordinary gateway body limit is unchanged.

GET permits only one `versionId`, preserving opaque non-whitespace version values including `+`, `/` and `=`. It verifies the actual S3 version, body digest, run, producer metadata and SSE headers. Literal `null` versions are refused. An unversioned discovery GET exists only to find an exact version after a conditional conflict or uncertain write; the existing client then performs a pinned GET before accepting its reference. AES256 and KMS response headers are preserved. S3 error bodies are not returned. A failed post-write authorization check may leave an immutable object but returns no successful receipt.

The separate AWS transport signs the exact version query and constrains the bucket/key namespace. Active-run keys are read-only. Artifact PUTs are conditional and bounded. Credential resolution, fetch and body reads have cancellation/deadline handling, no redirects, and declared/streamed size verification. No existing subscription broker path or body bound is widened.

## Client composition

`gateway-store.mjs` exports `createGatewayRelationshipStore`. It receives the existing `createS3ResolutionStore` factory, a fixed HTTPS `gatewayOrigin`, full `run`, `producer`, `sse`, `historyTrust`, `authorizeArtifact`, `getAuthorization`, and `fetchImpl`. `getAuthorization` supplies a complete Bearer header in memory. The wrapper validates the exact intended S3 URL and maps it to the fixed gateway route, preserving conditional, version and encryption semantics. There is no direct S3 fallback.

Durable workflow calls retain their existing `{run_id,caller_seat:"cfo"}` scope. The wrapper verifies it and adds its fixed full run and producer internally. History trust must include the fixed producer. Use the returned immutable `boundHistoryTrust` when constructing `createDurableResolution` so both layers share the reviewed store and producer configuration. The existing `authorizeHistory` dependency is still required; this wrapper does not fabricate history authorization or semantic verifier decisions.

Artifact references retain the existing bare artifact key schema. Reopening a reference requires the same trusted fixed run and producer configuration; a reference alone grants no authority. Historical retrieval after a cohort/run expires is refused by this transport. Any separate historical recovery authorization needs its own reviewed design.

## Validation

`test-output.txt` records synthetic local acceptance. Production TypeScript passes `tsc --noEmit`. Tests cover default-disabled policy, wrong seat/credential/producer, run and envelope tampering, conditional writes, revocation during I/O, corrupt/version/encryption refusal, exact 16 MiB acceptance and oversized rejection, bounded signed S3 transport, plus catalog and worker regression coverage.

The opt-in cross-repository tests import the actual CTO factory and durable workflow from the exact source above. They exercise AES256/KMS, duplicate 412 recovery, persisted 503 recovery with exact-version readback, durable source/history writes, negative/correction records, reconstructed retrieval without rerunning semantic verifiers, changed-source invalidation and revoked cohort denial. The source adapter uses an invented fixture; this is not a real catalog admission or live source acceptance.

On Windows Node v24.19.0, set `RELATIONSHIP_STORE_MODULE` to the reviewed CTO `tools/neptune-trial/relationship-adapters/s3-resolution-store.mjs` absolute path and run the selected tests with `--import ./tools/relationship-artifacts/typescript-test-loader.mjs`. The helper avoids the local cached tsx runtime issue and does not replace the separate production typecheck. Cross-repository tests explicitly skip when that module path is absent. The ordinary CI test command discovers the gateway tests and imported wrapper unit tests; gateway CI currently triggers only on PRs to main, not this stacked base.

## Remaining release work

The coordinator must integrate the client wrapper into the intended production durable workflow using reviewed history authorization and real producer configuration. Bucket versioning, scoped S3/KMS permissions, catalog/current-run policy and credential-fingerprint bindings need independent review and activation. A gateway deployment still requires release review, service stability, live revision, health and catalog probes. No live durability, policy or infrastructure acceptance is claimed here.

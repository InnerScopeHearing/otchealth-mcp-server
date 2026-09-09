# Automatic historical publication handoff

Base: PR322, `d6c0b61cf65e199e4cfdf32d7f0fd1bf6b656fdf`. This follow-up keeps that draft unchanged. The default-disabled `GRAPH_RELATIONSHIP_PUBLICATION_POLICY_JSON` is separate from execution policy and the explicit per-run historical grant policy.

## Behavior and authority

One current policy binding authorizes a CFO credential, named producer, cohort, purpose, run version, encryption and source policy. It does not enumerate runs or artifact digests. The POST publication endpoint derives an immutable server grant automatically from an existing server-issued cohort admission, its pinned proposal, and verified history/source artifacts. Admission discovery reads only the trusted server namespace, then exact version and body hash checks validate the chain. No admission is created and no execution run is reopened.

A grant records the run, original pinned admission/proposal, producer, authenticated caller hash, exact history reference and its derived source references. Hashes establish integrity only. Authority requires the current matching server policy and the authenticated server grant. The issuance policy version is an audit field, intentionally not an equality requirement on future reads. Current policy changes and expiry remain enforced. Credential rotation requires an explicit reviewed migration; grants are bound to the authenticated issuing credential hash.

Successful publication includes a create-only, read-verified S3 write in `graph-trial/20260908/relationship-publications/cfo/<cohort>/<producer>/runs/<run>.json`. Writes use AES256 and never overwrite. Retrying the same publication is idempotent; a different history for the same run conflicts. Source checks run before and after persistence. A revocation during persistence can leave an immutable record, but the request fails and future reads are denied. There is no cross-service atomic snapshot claim.

Artifact GET and listing both check current source access. Changed versions remain available as stale evidence for invalidation; missing/revoked sources deny. Producer, caller and policy checks remain fresh. Read requests do not execute reviews, reopen execution or call semantic verifiers.

## Paging and bounds

The S3 registry has no 64-record retention ceiling or local journal scan. ListObjectsV2 reads at most limit+1 keys and fetches at most limit records, with a maximum page size of 64. Tests traverse 66 records through the actual storage parser and paged client. Lexical run cursors are not snapshot cursors: new earlier-sorting publications require a new traversal from the beginning. Persistent global query indexing is a separate dependency.

Each route has a 45-second abort bound, at most 256 artifact/pin reads and 64 MiB cumulative artifact/pin bytes. Only the requested response is retained alongside bounded source validation inputs. Individual publication records are at most 128 KiB, POST bodies 16 KiB, and storage requests have a 15-second credential/fetch/body bound. Source pages retain their existing 1 MiB limit. A large page can hit the resource ceiling and must be retried with a smaller limit; the service does not evict old grants.

`createPagedRecallHost` publishes exact receipts, lists pages and reconstructs actual authenticated historical readers only for the selected page. Retrieval explicitly returns the page and cursor alongside a page-scoped answer. It does not claim a complete corpus-wide answer across arbitrary page boundaries.

## Proof and integration boundary

The synthetic fixture uses the actual CTO durable resolver, S3 store adapter, source bridge and planner at `4cd6a6e9b42c6714ccfd5f9b3749ed42a3e5c9e1`. Agreement, invoice and payment each have a distinct one-document admitted run but share one unchanged publication policy. It proves restart after admission 2 before any artifact 2 exists, restart after review 2 before publication 2, automatic recovery publication in a fresh child, publication 3, and a fresh-process combined path 120 simulated days later. Changed sources invalidate; source and producer revocation deny. No real document bodies, credentials or cloud services are used.

The fixture's trusted admission records and metadata registry persist in serialized synthetic state. It uses actual server-shaped proposal computation and route chain verification, not the live admission lifecycle. The production admission discovery adapter reads the existing authenticated server records. The production S3 registry is implemented but not provisioned or exercised live.

The scheduler must call publication after successful review and durably retain the exact review receipt so a crash before publication can retry without re-running an expired execution. The fixture proves this composition with saved receipts; production job wiring is not activated here. Server-only IAM ownership of the new grant prefix, versioning and retention must be reviewed before enabling. No IAM or live policy was changed.

The existing catalog controller still caps admissions at 1,000 per cohort. Multiple cohorts and a reviewed scalable controller policy are necessary for larger ingestion. This draft does not silently raise that cap. A whole-corpus relationship index, cross-page graph composition and scheduled cursor rescans remain architecture dependencies.

Root independently identified a streaming signal lifetime bug in the unchanged PR322 `historical-reader.mjs`. Root owns its isolated correction and tests. This follow-up intentionally does not edit those files; integrate that correction before use. New publication store and paged-client requests retain their abort signal through body consumption.

Validation is recorded in `publication-test-output.txt`. Production TypeScript compilation is also required. The actual-store integration tests explicitly skip without `RELATIONSHIP_STORE_MODULE`; the recorded run supplies it and has zero skips. PR316 and CTO PR190 holds remain untouched. No deployment or activation is included.

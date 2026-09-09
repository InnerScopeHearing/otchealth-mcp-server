# CFO catalog cohort transport

These routes are registered in the gateway and disabled until the trusted `GRAPH_CATALOG_COHORTS_JSON` setting contains an approved cohort. An empty setting performs no catalog or state access. Only an authenticated CFO connector can use them. Neither the HTTP request nor Windows host configuration can select a seat, policy, source URL, storage prefix or admission maximum.

Trusted configuration is an array of at most 32 unique cohorts. Each cohort requires exactly `cohort_id`, `catalog_key`, `catalog_source_sha256`, `source_prefixes`, `purpose`, `run_version`, `batch_size`, `max_admissions`, `policy_sha256`, and `expires_at`. Optional recovery configuration requires both `recovery_policy_sha256` and `recovery_expires_at`. Dates are canonical ISO UTC strings. Batch size is 1 through 10; lifetime admissions are 0 through 1000. Zero disables execution. Source prefixes are 1 through 16 normalized relative paths ending in `/`. `catalog_key` is a normalized `.jsonl` object key below `graph-trial/` in the fixed DR bucket. The source hash is the explicitly reviewed catalog identity, not a caller authorization claim.

The catalog reader sends HEAD then GET with If-Match, checks exact ETag and byte length, derives its timestamp from Last-Modified, and bounds JSONL to 192 MiB, 100,000 rows and 1 MiB per line. Selected metadata remains in the CFO boundary. The gateway does not return full catalog contents to the host. It reads the catalog afresh for each page, publication and current-source check; batch size does not bound that metadata read cost.

## Route contract

All paths start `/graph-catalog/v1/:cohortId`. Query strings, arbitrary state paths and non-CFO callers are refused. Requests and responses carry no credentials or presigned URLs.

| Method and suffix | Contract |
| --- | --- |
| GET `/config` | Trusted enablement, controller identity, policy hash and lifetime admission maximum. |
| POST `/page` | Exact `{cursor,limit}`. Returns pinned catalog identity and a deterministic bounded metadata page compatible with the existing source bridge. |
| POST `/publish` | Exact one-document `{manifest,rows}`. Revalidates the current source row, conditionally publishes and reads back immutable row/manifest artifacts and server-owned proposal records. |
| GET `/manifests/:sha` | A cohort-published immutable manifest only. |
| POST `/source-current` | Exact `{item}` returns `{current:boolean}` after a pinned metadata read. |
| GET/PUT `/state/*` | Only `cursor` and `versions/<sha256>`. ETag CAS, conditional creation, exact readback, schema bounds and monotonic version-state transitions. |
| POST `/admit` | Exact `{key,manifest_sha256}` referencing a server-owned published proposal. Returns a policy-bound exact run admission receipt. |
| POST `/review` | Exact `{key,run_id,manifest_sha256}` checks an already issued current admission. No caller-supplied decisions accepted. |
| POST `/recovery` | Exact `{key,run_id}` checks separate recovery authority for an existing admission. |
| GET `/recovery-state/:runId/:artifact/:operationId.json` | Read-only operation/result data for a recorded, prepared source chunk of the exact admitted run. No list, arbitrary source reads, writes or dispatch. |

Admission uses one CAS `server/control.json` record. Its `used` count and `current` reservation move together before any authority becomes usable. Reserved runs are not accepted by the worker broker. Immutable admission and active-run registry records must be confirmed before the final active pointer is committed. Retry of the same active admission does not spend another count. A different admission cannot replace the current run until every prepared chunk has matching durable operation/result evidence. Lifetime count exhaustion never creates another active run.

The existing worker broker delegates dynamic cohort lookup and every recheck to `resolveCatalogCohortBinding`, then retains its ordinary active-run check and source/operation constraints. Static bindings retain their prior path. The CFO 256 KiB source canary and ordinal-zero manifest restriction are unchanged.

Execution expiry prevents new paging, publication, admission and worker authority. While the separate recovery policy is valid, progress state can be read and existing held/dispatching state can become verified complete. Such writes preserve the proposal, preparation and operation identities and validate all immutable results. General state/cursor writes stay denied. Keep the cohort configuration and its original policy identity available through the recovery window; deleting it revokes recovery. Policy changes require a newly reviewed cohort identity.

Incomplete evidence, subscription pauses, uncertain dispatch, admitted deferred source outcomes, and expired admissions without durable worker receipts remain held. There is no retry lease, budget reset, paid fallback or automatically fabricated completion. A crash during initial publication followed by a changed catalog timestamp may leave an immutable proposal needing owner reconciliation.

## Validation and activation boundary

Tests use synthetic in-process Fastify requests and synthetic S3 responses. The paired CTO `catalog-controller/gateway-wire-acceptance.mjs` exercises actual host/client/controller/worker composition, including automatic two-document selection, expired recovery and server budget enforcement. Production TypeScript is typechecked separately. These are engineering receipts, not a live source or production acceptance claim.

This draft is based on gateway commit `61b3c285bf891435d6e0ebcb87590aed6e0e7b49`. It does not modify or release PR316. The operator still needs approved cohort configuration, an exact allowed catalog object or separately reviewed metadata mirror, scoped task-role storage permissions, release review and a verified gateway deployment, plus the separately provisioned CFO Windows subscription host. No IAM, deployment, token reset, scheduled task or live extraction is performed by this change. Current main security and Hyperagent changes belong to their respective owners and must be coordinated before rollout.

Relationship artifact transport remains deferred. It requires an independently reviewed larger-payload, exact-version immutable storage contract. These routes do not widen the subscription broker allowlist for it.

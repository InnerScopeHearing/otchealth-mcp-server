# Historical relationship read handoff

This draft is stacked on gateway PR320 at `0e41d35b95c2c3fd9c1f6de53b5edb83e28fe7de`. Cross-repository validation uses CTO PR191 source at `4cd6a6e9b42c6714ccfd5f9b3749ed42a3e5c9e1`.

## Verified behavior

The unchanged PR320 artifact route denies a pinned run-1 GET with HTTP 403 after run 2 becomes current. The synthetic restart test preserves published run 1 while run 2 is admitted but has written no artifacts. A fresh child process retrieves run 1 at this point. After run 2 is reviewed and published, another fresh process retrieves the combined invoice-to-agreement-to-supplier path 120 simulated days later, beyond execution expiry. Changing a supporting source invalidates the prior path; revoking source or producer access denies retrieval.

The fixture uses actual durable store, resolver, source bridge, planner and host composition factories. Synthetic admission/proposal receipts use actual server schemas and proposal computation. It does not execute the live catalog admission lifecycle or prove a live deployment. Existing catalog tests remain included. All documents, versions, credentials and storage responses are synthetic.

## Read authority

`GRAPH_RELATIONSHIP_HISTORY_POLICY_JSON` defaults empty. The GET-only `/relationship-history/v1/:runId/:producerId/sha256/:shard/:digest.json` route requires an exact `versionId`. It does not reopen execution or consult the current-run write guard. The original artifact writer is unchanged.

A `relationship-history-policy-v1` policy has `policy_version`, `expires_at` and `bindings`. Each binding supplies authenticated caller and credential hash, producer ID, exact original run, encryption, cohort ID, pinned admission and proposal `{key,version_id,sha256}`, explicit `approved_artifacts` `{digest,version_id}`, and `source_policy` containing catalog key, catalog source identity SHA and allowed source prefixes. Authority comes from this reviewed current server policy and authenticated pinned admission/proposal records. A digest establishes integrity, never permission. Historical artifacts and referenced sources must each be explicitly approved.

Current catalog metadata and the existing CFO snapshot reader verify source access and currentness. Missing or revoked sources deny access; changed sources return stale authority for resolver invalidation. Policy, identity and source checks are repeated before returning. Reads require exact versions, fixed storage namespaces, bounded bodies and encryption metadata. No IAM, live policy, deployment or activation changes are included.

## Host integration

`createRelationshipHostComposition` accepts actual resolver/store/durable factories, explicit run/producer/history trust, source adapters and verifier callbacks, gateway origin, journal directory, credential callback and a trusted admission verifier. It exposes admission, review/publication and retrieval operations. No credentials, semantic verifiers or admission authority are supplied by default.

The metadata-only local journal preserves published entries when another run is pending. It uses append-only hash-linked records, flush and create-only hard links, supports restart and rejects concurrent conflicting publication. It has no retention TTL. It contains references, not document bodies or credentials.

The production scheduler and catalog CLI are not wired by this draft. The coordinator must supply real admission verification, reviewed current read grants and producer trust. If review succeeds before its historical read grant is configured, the job must durably retain the exact review receipt and retry publication after authorization. Earlier published history remains available. There is no automatic allowlist renewal or grant creation.

Bounds fail closed rather than evict: 64 readers/runs per recall, 64 policy bindings, 256 approved references per binding, 16 MiB artifact payload plus envelope allowance, 1 MiB prepared source, and 10,000 journal records by default (configurable up to 100,000). Incompatible independently reviewed histories can fail with replay divergence instead of silently merging conflicting state.

## Validation

`historical-test-output.txt` records the targeted synthetic gateway suite, including fresh-process cross-repository tests. Production TypeScript compilation passes. Supply `RELATIONSHIP_STORE_MODULE` pointing to the pinned CTO `s3-resolution-store.mjs` to run those integration tests; they explicitly skip when absent. Gateway CI is configured for main, so this stacked draft carries local receipts and does not claim a CI run or an operational graph.

PR316 and CTO PR190 release holds remain untouched.

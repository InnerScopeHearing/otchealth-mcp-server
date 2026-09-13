# Brain capability foundation v1

This is an incremental implementation, not an assertion that all eleven capabilities are complete.

## Runtime changes

`memory_write` accepts an optional `idempotency_key` with 16-128 ASCII letters, digits, dots, underscores, colons or hyphens. The same authenticated agent, key and original request return the same committed record. A changed payload fails with a generic conflict. The original request includes kind, text, ordered tags, source and explicit supersedes. Automatically detected supersession does not alter that request fingerprint.

The key is not persisted. A lane-scoped SHA-256-derived record ID, request hash and original explicit supersession reference are retained on the existing state record. Readback recomputes the content fingerprint rather than trusting the stored hash alone. Unique creation uses the existing store backend, currently the PostgreSQL dispatcher in the AWS estate. A lost create acknowledgment is reconciled with exact readback. No new table, cloud service or migration is introduced.

An existing replay is looked up only after identity, lane, broadcast-safety, configuration and dry-run gates. It does not spend another embedding call. `persistence_state: committed` is distinct from `indexed`; a pending projection remains an existing reconciliation obligation. Requests without a key retain legacy append behavior, so the tool-wide idempotent hint remains false.

Limitations: concurrent first attempts can both embed before one wins the unique create. The loser then returns a replay receipt without another projection or its own supersession guess. Idempotency lasts while the authoritative record is retained; physical deletion requires a separate durable tombstone policy before promising replay protection beyond deletion. This change does not authorize confidential content in the broadly recalled memory store and does not create automatic chat-turn capture. Clients must explicitly supply the operation key and check the receipt.

The optional Descope path now rejects malformed JSON token shapes, nonnumeric/nonfinite expiry and invalid or future not-before claims. Explicit audience matching is implemented and tested as a verifier option, but production audience binding is NOT activated until the actual accepted token profiles and expected audience are verified. Static seat tokens, pilot lane configuration and existing revocation controls remain unchanged.

Independent review also found a pre-existing durable OAuth authorization-code consumption race. The revised consume path uses the exact read ETag for conditional deletion and returns the code only after confirmed deletion. A second consumer, missing ETag, storage error or uncertain delete fails closed. An uncertain successful deletion can require fresh sign-in rather than risking duplicate token issuance. This does not change PKCE, lane elevation or static credential behavior.

## Reusable components, not yet public tools

`src/brain-capabilities/contracts.ts` defines strict neutral assertion, evidence, temporal, coverage, idempotency and receipt schemas. Structural validation does not prove source authority, semantic truth, or access permission. Caller-supplied verification metadata is never a production verifier.

`src/brain-capabilities/evidence-view.ts` provides pure, policy-callback-based evidence selection and structured briefs. It requires tenant scope and complete premise authorization; unknown validity is not silently treated as current truth. Runtime integration must bind trusted current identity and policy, not expose the authorization callback or a caller-controlled allow flag.

Earlier InnerScopeHearing CTO drafts 188, 192, 196 and 198-201 contain relationship resolution, immutable evidence adapters and review protocols. These components do not replace those drafts or activate synthetic verifiers against company documents. The active CTO owner retains source workers, GraphRAG ingestion, existing graph/KB and checkpoint ownership.

## Completion map

| Capability | Foundation contribution | Still required before completion |
| --- | --- | --- |
| Unified memory | Existing durable store plus retry-safe capture | Complete source inventory and approved connectors |
| Semantic questions | Structured evidence output primitives | Query planning, typed metrics and retrieval benchmarks |
| Temporal memory | Valid and recorded-time contracts | Persistent history, correction/retraction integration and production as-of tests |
| Cross-department reasoning | Full-premise authorization selection | Source-native policy binding and tested authorized joins |
| Persistent sessions | Stable capture keys and receipts | ChatGPT/Claude seat-specific end-to-end save/restart/recall tests |
| Graph synthesis | Evidence/version contracts | Existing relationship adapter integration, merge/unmerge and full backfill |
| Proactive intelligence | No detector activated in this increment | Shadow detector state, suppression, withdrawal, owner routing and approval controls |
| Provenance | Immutable version/hash/span contracts | Original-source readback, authoritative verifier and export lifecycle |
| Confidence semantics | Verified/inferred/unknown distinct from lifecycle and coverage | Trusted promotion and contradiction adjudication |
| Role views | No permission expansion | Actual policy bindings, revocation and cross-client denial tests |
| Executive support | Structured evidence brief primitive | Complete decision artifacts, typed calculations and human-reviewed usefulness |

## Verification and release gates

Focused Node tests cover contract validation, source denial, temporal intervals, JWT claims, idempotency collisions, concurrent create, uncertain acknowledgment, permission-before-replay and legacy behavior. Full CI must additionally run the repository's PostgreSQL-backed integration suite. Local mocked readback does not substitute for a production store test.

Before release: review exact head, pass required CI, merge through an organization PR, build immutable ECR digest, coordinate expected predecessor with the active CTO conductor, preserve all current task-definition settings, wait for stable replicas, and independently check health, identity, catalog and synthetic keyed-memory readback. No new source ingestion is part of this release. Record the actual revision and test receipts before claiming deployed.

Rollback may use the previous image without deleting new memory records: old readers ignore the additive metadata. Rolling back also removes keyed capture support, so clients must not interpret a rollback as preserving idempotency. No secret values or protected source bodies belong in release evidence.

# Synthetic relationship pilot

This disabled-by-default gateway pilot proves selected relationship storage and query behavior using five fictional fixtures. It does not ingest company documents, extract relationships with a model, or establish fleet-wide knowledge coverage.

The three relationship_pilot tools require the authenticated CTO lane. Enablement requires RELATIONSHIP_PILOT_MODE=synthetic and the existing gateway write controls. All paths, evidence, fixture values, policy and transaction time are selected by the server. Input cannot select a protected room or alternate storage prefix.

Events are immutable S3 objects under the existing commons mapping and _MEMORY/_relationships/pilot-v1/. Supply one stable idempotency key per operation. On UNKNOWN durability, retry the same fixture and key. A successful replay preserves the original event and recorded time. Stored permission or semantic changes are refused even when intent identifiers are copied.

The graph projection uses immutable generations and writes the manifest last. Query selects the exact current event-set digest, then applies separate valid-time and recorded-time filters, source permissions, and a one- or two-hop limit. Candidate links are excluded by default. A projection failure after event persistence reports persisted=true and projected=false so rebuild can recover the event.

Controlled verification covers permission denial, dry run, lost-response replay, immutable-record integrity, historical corrections, candidate exclusion, two-hop traversal and recovery after an interrupted rebuild. Thirty-five focused relationship and S3 tests pass, and TypeScript passes. The broader local suite needs its normal Linux/PostgreSQL CI environment; its unrelated failures are documented in the CTO audit receipt.

The read limit is 100 events, 50 entities and 100 returned edges. A full store refuses a new operation while allowing an existing key to replay. This is a bounded serial pilot, not a distributed capacity reservation: simultaneous new operations near the limit can exceed it, after which reads fail closed. Do not run concurrent ingestion near the limit or extend this pilot to a real corpus. No prefix deletion is part of rollback.

Release acceptance must verify real synthetic S3 persistence, a fresh process reading it, response-loss reconciliation, both running ECS tasks, direct non-CTO refusal, and disabled-mode refusal. Keep the flag off until those checks can be executed. No new recurring AWS service is required; S3 requests, storage and existing gateway compute are still metered.

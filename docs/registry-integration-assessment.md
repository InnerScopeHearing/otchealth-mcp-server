# Source identity registry integration assessment

Assessment date: 2026-09-09. Source and synthetic verification only. No deployment, live source processing, activation, or complete-corpus claim.

## Exact inputs and verification

PR329 remains unchanged at ca2dbf70ea452acc0a9855df905e34fdde0e7ab7. Assessment branch starts there and cherry-picks registry component 4b026709195d1d6cd642a4e483e473d37eb0eb10 as 8a8769f4917716cc4bcb883abf76680711e975d3. The requested 4b02670c44e2d0bb00618277793b104d893732a3 was not the named checkout's commit. CTO client/exporter checkout is d47fc97eeccba929577445280d122fea09c59785.

The initial combined production TypeScript compilation failed with four diagnostics: unknown page_size comparisons and insufficient snapshot union narrowing. Two local explicit type guards fix these without changing intended accepted inputs. Production tsc then passed. The actual identity-registry-wire.mjs against the CTO checkout passed with published:true and revoked_read_denied:true. Its source, key and persistence are synthetic and in memory. This is interface compatibility evidence, not durability or operational evidence.

## Remaining implementation requirements

1. Production startup has no registry resolver: src/server/index.ts:101 registers the broker without injection, and graph-worker-broker.ts:294 only accepts an injected identityRegistry. Configure a deployment-owned resolver and approved source authority. Do not let models or candidates choose trust keys, IDs or authority.
2. Implement an authoritative structured-source adapter that binds explicit namespace/scope/value identifiers to the exact prepared document version, chunk SHA and literal mention. A display name is not identity evidence. Ambiguous or absent IDs remain unresolved. The supplied component only defines callbacks; the wire proof supplies synthetic records.
3. Implement durable conditional snapshot publication, immutable version reads, authoritative revocation state and an approved signing adapter. Current proof uses a Map and ephemeral key. Verify restart recovery, concurrent create conflicts, stored content/hash readback, revoked/missing versions and failure paths. No secret value belongs in config or reports.
4. Define live authorization independently of a retired producer run. identityContext at graph-worker-broker.ts:838 binds registry access to a configured active run. A subsequent run must obtain an explicitly authorized registry reference; do not silently reuse a retired binding or bypass current policy.
5. Implement source-change to revocation/publication orchestration and pin refresh. Snapshot GET at graph-worker-broker.ts:1009 consults stored revocation state, deliberately not source.current. Thus automatic source currentness requires a real authoritative revocation/update adapter; the synthetic proof does not establish it.
6. Revalidate identity authority when retrieving saved relationships. CTO relationship-adapters/durable-resolution.mjs:147 replays recorded verifier results; retrieve at line225 refreshes source/history checks. That code path does not refresh the signed identity registry receipt. Source review identifies a missing hook for registry version/key/entry revocation. This assessment has not run an end-to-end saved-answer revocation regression and does not claim that scenario is empirically proven. Require that regression before readiness, including cross-run recall.
7. Bound callback execution as well as request sizes. Passing an AbortSignal alone cannot force an adapter that ignores cancellation to settle. Also enforce returned record count against requested page_size, not only the fixed maximum.

## Partitioned full-corpus authority

CTO source-identity-registry/exporter.mjs:11 caps one export at 1000 records and line13 caps the signed envelope at 256 KiB; gateway validation caps entries and revocations at 1000 each. Do not raise these to an unbounded corpus size. A corpus with more than 47,000 documents also does not imply the same number of identity entries: one document may have zero or many.

The smallest useful scalable extension is a signed, versioned run manifest plus bounded signed partitions. The manifest must pin authority and source generation, catalog receipt/version and expected document/chunk coverage, partition routing rule, every expected shard ID/version/hash, supported schema and signing key identity. Publish shards immutably first, verify each, then conditionally publish the complete manifest as the admission unit. Paginate a large shard manifest if necessary, with a signed root covering all pages.

Use deterministic partition routing over an explicit authoritative identity key or source binding. Keep namespace/scope/value unchanged across partitions. Never invent new equivalent IDs to make shards join. An X-to-Y edge and Y-to-Z edge may join only on the same approved scoped ID, with source and relationship verification for each edge.

Admission must reject mixed source generations, duplicate/conflicting entries and incomplete manifests. Export checkpoints should identify the fixed source generation and next shard so retries cannot omit or duplicate coverage. Currentness checks must cover the manifest and every shard actually used, including key and entry revocation. Replacements require an explicit manifest transition with durable revocation handling for old receipts.

Missing, inaccessible, stale, revoked, timed-out or unprocessed shards mean incomplete/unknown, never a negative answer. A no-match claim requires current authorization and complete coverage of all partitions relevant to the query. A page-scoped answer must disclose its scope. Full-corpus readiness additionally requires coverage reconciliation against the fixed source catalog, not a count of published snapshots.

Required synthetic proofs: cross-shard X-Y-Z using the identical explicit middle ID; same-name distinct-ID non-join; conflicting scoped IDs rejected; missing last shard; stale shard; mixed generations; revoked key/entry after saved review; restart during publication; pagination exhaustion; denial of an incomplete negative answer. These partition features and tests are not implemented by the assessed component.

## Release conclusion

The bounded registry interface can compile and exchange a synthetic signed snapshot after two local type fixes. Automatic authoritative identity integration, persistence, lifecycle revocation, query-time identity refresh and complete partition coverage remain implementation work. Keep candidate-only processing explicit until those dependencies and their operational checks are complete. An evidence-backed X-Y-Z path is a qualified source assertion, not independent proof that every real-world statement is true.

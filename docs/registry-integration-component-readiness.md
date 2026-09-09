# Registry component integration evidence

Source and synthetic verification only, 2026-09-09. No deployment, live source processing, IAM changes, new AWS resources or activation occurred in this lane. PR329 stayed at ca2dbf70ea452acc0a9855df905e34fdde0e7ab7. This report updates the earlier registry-integration-assessment.md findings; it does not certify the estate as operational.

## Implemented and checked

Query-time identity revalidation preserves the immutable review transcript but refreshes pinned identity proofs before returning a current relationship answer. Missing, changed, unavailable, revoked or timed-out authority downgrades affected relationships to unverified candidates. Previously unresolved candidate-only records keep their original uncertainty. Source/history access is rechecked after identity I/O. Separate checks are not an atomic authorization lease.

The gateway supplies the authority callback and refresh helper to cross-run recall and through the ordinary executable composition. An old resolver without identity-currentness support is rejected. The paired CTO source is required; the former d47 runtime does not contain the helper.

Partitioned signed registries use a compact complete hex-prefix routing tree, immutable shard hashes and versions, stable scoped explicit IDs, and an authoritative catalog membership/page adapter. Full coverage requires count and digest reconciliation of the pinned catalog and every shard. An omitted binding, missing/stale/revoked shard or incomplete catalog page cannot become a negative relationship answer. No names are inferred equivalent. Signer/callback execution and envelope sizes are bounded.

The S3 adapter adds conditional immutable snapshots, version-pinned receipts, persistent revocation tombstones, integrity/readback checks, bounded signing/transport/body reads, configured encryption checks and lost-acknowledgment reconciliation. An absent artifact after an ambiguous write remains UNKNOWN. Normal reads do not write. A filesystem adapter remains useful for local testing but is not the shared ECS storage solution.

## Evidence and limits

- 142 relevant CTO tests passed with zero skips across relationship adapters, resolver, subscription review and source identity registry.
- 12 gateway tests passed with zero skips, including ordinary executable composition against the updated CTO checkout.
- Actual synthetic cross-run wire: a signed path across two histories qualifies before registry revocation, invalidates afterward, preserves three candidates and denies access revoked during identity refresh.
- Actual synthetic broker/client/exporter/S3 wire: conditional publication, recreated adapter read and persisted revocation denial all pass. All S3 traffic is an injected synthetic transport. No real AWS request was sent.
- Synthetic scale evidence: 47,000 source-binding hashes reconcile through 47 bounded catalog pages and 256 signed shards. The root remains under 256 KiB. Omitting the final page fails completeness. This proves the tested bounded algorithm, not actual company-corpus coverage or ingestion.
- The actual relationship-review test uses signed partitions and explicit IDs, then retrieves in a fresh workflow and invalidates after shard revocation. Separate durable retrieval tests use a fresh Node process with the actual gateway client and signed verifier.
- Filesystem and S3 store reconstruction tests recreate adapter instances in one process. They are not process-restart or power-loss certification. Windows filesystem durability is explicitly unproven; its normal constructor refuses durable use.

## Still required before operational certification

1. Configure and verify the production explicit-ID source adapter, catalog membership/coverage authority, signer and source-currentness/revocation lifecycle. Source bindings must match actual prepared versions and chunks. Do not replace these with invented identifiers or names.
2. Deploy and verify the implemented partition manifest/shard publication, read, currentness and coverage routes. The ordinary CLI now selects `partitioned-signed-review`, validates every shard before controller startup, and refreshes credentials from the same authorized source for each request. Local wiring does not activate production processing.
3. Configure the S3 adapter using the intended bucket and prefix, with independently verified versioning and immutable/delete-protection policy for snapshots, receipts and tombstones. immutableTombstonePolicyAttested is a configuration assertion, not cloud policy evidence.
4. Integrate paired gateway and CTO source revisions through the owning review/release task, then verify hosted checks, running revisions, real authorized downstream artifacts, recovery and monitoring. Nothing here establishes a successful release.
5. Preserve page/query coverage scope. A source-backed X-Y-Z assertion is not independent proof of every real-world claim. Missing authority or incomplete coverage must remain explicit uncertainty.

Independent review identified and corrected candidate-only uncertainty wording, final identity I/O ordering, filesystem corruption/regular-file handling, partition coverage and missing-binding handling, and S3 bounded-read/integrity issues. Final source hashes and final review confirmations are supplied in the coordinating task handoff.

## Recovered integration validation

The paired CTO source is PR191 head `18d94eac8b51f009fca54b8da967577769e54096`, with 460 local Graph tests and all four hosted workflows passing. Root compiled this gateway and passed 23 gateway/catalog tests using the strict TypeScript loader. Eight credential and actual CLI tests passed without skips, including rotation between manifest and shard requests, complete 16-shard preflight, missing-shard refusal and Windows preparation. The synthetic cross-repository wire passed bootstrap publication, duplicate rejection, S3 snapshot pins, qualified path and revoked-shard invalidation. No real AWS requests or document processing occurred. Source adapters, signing and storage policy configuration remain outstanding.

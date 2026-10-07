# Brain agent upgrades - 2026-10-06

These changes upgrade existing gateway tools. Deployment completion is recorded in the CTO release bulletin with the exact source commit, image digest and ECS revision.

## Agent workflow

1. Start or resume with `wake` using your own authorized lane. Full, brief and M365 views apply known same-lane supersession across stores. Use record IDs to retrieve complete evidence before acting; absence from a preview does not prove absence from storage.
2. Use `tasks.active` to resume unfinished work. Wake queries open, claimed, in_progress and blocked before applying bounded limits. `counts_scope=bounded_active_status_samples` means counts describe sampled active statuses, not a complete board total. The summary reports the items actually shown.
3. Ground current facts with `brain_search` and cite returned IDs. When already authorized deep mode resolves a current entity, its completed answer uses that typed current value. Domain and lane gates still apply. Existing partial answers retain their citations and continuation. If a supporting memory is retracted during synthesis, the answer is withheld, current citations are rebuilt, and `retraction_changed` returns a partial continuation; resume it as instructed by the response.
4. Inspect `retraction_verification`. `incomplete` means an authoritative retraction source was unavailable. Known retractions remain filtered, but completeness is unverified: obtain authoritative evidence before relying on a possibly stale claim. This field does not prove all documents were loaded.
5. Use `checkpoint` for explicitly supplied independent memories. Up to four deliveries run concurrently while each record still writes before indexing. Receipts retain input order; any supersedes batch stays serial. Claim success only for confirmed stored and indexed IDs, read back exact records, and reconcile uncertain writes before retrying.

## Operating limits

No new tool names, installation, paid model jobs, grants, infrastructure capacity or schedules are introduced. Existing company-only data limits, provenance, legal-lane isolation and cost authorization remain in force. Deep synthesis still follows its existing provider path; the current-value change does not remove its inference cost. A shared bulletin and queued inbox message prove publication/delivery, not that every agent adopted the guidance.

## Acceptance evidence

Focused regression coverage checks current-memory filtering, cross-lane ID collisions, older unfinished tasks behind terminal rows, current-value provenance, shield withholding, partial citations, failed-source disclosure, refresh races, ordered checkpoint receipts and partial failure. Immutable image fixtures exercise all five changes with synthetic content and provider I/O replaced. The checkpoint helper benchmark used 20 independent entries with injected write/index latency and two failure outcomes: serial 1275.8 ms versus cap-four 319.0 ms across three runs (75% lower synthetic latency). Production latency improvement remains unmeasured.

Rollback is the previous healthy gateway task definition, revision 189, until the release bulletin records a newer baseline.

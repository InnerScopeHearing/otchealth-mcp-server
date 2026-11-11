# Own-role memory metadata inventory

The historical-import rollout needs a source inventory beyond the existing 100-record search cap. `memory_search` gains an optional `inventory: true` mode. Ordinary search and exact-ID behavior retain their existing access rules and response shape.

Use the authenticated source-owning role's native connection:

1. Call `memory_search({inventory: true, limit: 50})`.
2. Journal the returned IDs and `scan_started_at`. If `has_more` is true, call again with the exact `next_cursor`, `inventory: true` and the same page size.
3. Continue until `has_more` is false. Reconcile unique IDs and any null/invalid metadata. A truncated observation, failed request or stored cursor is not an end-of-list result.
4. Retrieve and qualify each permitted original separately. An inventory row is neither permission to disclose a source nor evidence that its statement is current.

The mode projects only ID, agent, kind and creation date at the storage query. The response also reports metadata validity. Missing or invalid optional metadata becomes null while its source ID remains in the queue. Text, source attribution, tags, customer fields, amounts and arbitrary record properties are never fetched by the inventory query.

The authenticated caller supplies the partition. The agent predicate independently binds that same lane. A cursor cannot choose another partition. Inventory permits only these company identities: cto, developer, coo, cro, cfo, clo, and wefunder-campaign-director. A different requested agent, an unidentified caller, non-company lane or protected Personal lane is denied before a provider query. Record-ID and content/category filters are rejected in inventory mode so a filtered result cannot be mistaken for the role's inventory.

Continuations use keyset ordering by source ID, with one lookahead row and a hard 101-row maximum. The cursor contains version, owner, last ID and the original scan start time. It is validated on every call; it is not an authorization token. Provider and cursor errors omit payloads and transport detail.

This is explicitly a **live keyset listing, not a transactional snapshot**. Concurrent inserts with IDs behind a page boundary or deletions can change the corpus during enumeration. The scan-start field is an observation label, not a time filter or completeness certificate. For a final historical census, reconcile source changes during the scan or obtain a stable source snapshot through an accepted route. Do not claim full lifetime coverage from one capped search, one page or a scan affected by unresolved mutations. The tool does not assert a total source count.

This change adds no Supermemory write, transcript reader, credential, grant, background job, store bypass or automatic client adoption. Source holders and publication holds remain unchanged. Existing store dispatch selects its configured backend; this feature neither activates nor reconnects any retired backend.

Validation status belongs in the PR receipt. No new behavioral tests are added or run under the current rollout direction. This draft must not be described as deployed or accepted merely because its source is saved.

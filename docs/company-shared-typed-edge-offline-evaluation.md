# Company shared typed-edge fallback, offline evaluation

Date: 2026-09-28

## Decision

For exact, bounded relationship questions, reuse the existing immutable relationship resolver and citation contract before adding an RDS edge table. This prototype is synthetic-only. It does not open a company source, publish a relationship history, call RDS, write to S3, invoke a model, or change the Bedrock/Neptune pilot.

The production relationship publication route currently binds authenticated CFO finance and corporate CLO company-legal scopes. Its server-owned source, worker, publication and identity checks are not authority to read or publish the `company_shared` partition. The existing `graph_company_shared_relationship_query` is a fixed CTO-only synthetic fixture. It proves the resolver and citation behavior, not a company source publication path.

## Edge and citation shape exercised by the prototype

An accepted edge keeps its typed assertion and source witness together:

```json
{
  "schema": "relationship-resolution-v1",
  "candidate": {
    "subject": "X",
    "predicate": "depends_on",
    "object": "Y",
    "document_version_id": "docv_<sha256>",
    "source_sha256": "<prepared-chunk-sha256>",
    "evidence_start_utf16": 0,
    "evidence_end_utf16": 44
  },
  "assertion": {
    "semantic_intent": {
      "authority": { "source_room": "company_shared", "source_index": "company-shared-synthetic" },
      "permission": { "decision_source": "authenticated_gateway", "policy_version": "synthetic-v1", "allowed_roles": ["cto"] },
      "subject": { "entity_id": "entity_<sha256>", "registry_version": "relationship-resolution-v1" },
      "predicate": "depends_on",
      "object": { "entity_id": "entity_<sha256>", "registry_version": "relationship-resolution-v1" },
      "assertion_class": "fact",
      "witness": {
        "document_version_id": "docv_<sha256>",
        "source_version": "<prepared-chunk-sha256>",
        "evidence_kind": "exact_byte_span",
        "span_start_byte": 0,
        "span_end_byte": 44,
        "span_sha256": "<quoted-span-sha256>"
      }
    }
  },
  "citation_receipt": {
    "schema": "company-shared-citation-receipt-v1",
    "source_group": "company_shared",
    "source_id": "<sha256>",
    "source_version": "sha256:<prepared-chunk-sha256>",
    "provenance_receipt_sha256": "<sha256>",
    "citation_id": "cite_<sha256>"
  }
}
```

The real source path must derive `source_id`, source version, scope, exact span, identity proof and citation receipt from owner-approved source metadata. The placeholder names above are schema fields, not values to copy into a live publication. A source version that is revoked or no longer current must invalidate the path and its citations.

## Acceptance matrix

| Case | Synthetic input | Required result |
| --- | --- | --- |
| Positive | `X depends_on Y`, `Y depends_on Z`; query `X` to `Z` | `qualified`, two typed edges, two source-version citations |
| Reverse | Same edges; query `Z` to `X` | `unsupported`, no conclusion, no citations |
| Wrong predicate | `X owns Y`, `Y depends_on Z`; query `X` to `Z` | `unsupported`, no conclusion; supporting records may be shown but cannot form the dependency path |
| Revoked version | Positive path; citation-currentness callback rejects its source versions | Not qualified, no citations |
| Cross scope / caller | Change scope/index or call as CFO, CLO, CLO Personal, or non-connector CTO | Fail closed; no protected history is opened |

The first four cases execute against the existing replay resolver. Scope/caller checks are exercised by the registered synthetic tool tests. No test fixture represents a company document.

## Cost and implementation comparison

| Route | Additional infrastructure | Proven cost and limits |
| --- | --- | --- |
| Existing immutable relationship substrate | Reuse the resolver, history replay, identity/source-currentness checks and citation receipts. A production company-shared publisher still needs separately authorized source/store bindings and a server-owned scope. | No new subscription or RDS work in this offline prototype. Production S3 request and storage cost is not measured here. Existing publisher code is closed to finance and company-legal today. |
| RDS edge table | Table/schema migration, source-version uniqueness and correction rules, writer, read API, connection/pool budgets, VPC route, DB role/grants, rollback and backup validation. | RDS is an existing service, so the incremental service charge could be zero if spare compute is demonstrated. That spare compute and SQL grants are not established by this prototype. |
| Managed Bedrock GraphRAG | Current pilot has separate provider ingestion, graph/KB quotas, workflow and source lifecycle gates. | No new worker or provider operation was started. Compare against the parent pilot's terminal quality and gross-cost receipts before changing rollout direction. |

The last live metadata-only health report found `otchealth-pg` available, PostgreSQL 18.3, class `db.t4g.micro`, 20 GiB allocated, about 17.9 billion bytes of free storage (about 16.7 GiB), 2 to 6 database connections and 3.7 to 4.5 percent CPU across the observed 24-hour window; freeable memory averaged about 85 MiB. This is not a sizing test. The instance was not publicly accessible. The report reads AWS metadata and aggregate CloudWatch metrics only; it does not query SQL or establish any login's table privileges or effective connection limit.

## Result

The synthetic evidence supports a deterministic bounded two-hop answer contract. It does not prove that company-shared sources can be published under the current CFO/CLO store policy, nor that RDS has suitable write capacity or grants. Reusing the assertion/history engine is the smaller typed-edge prototype. RDS is not yet a verified lower-cost production path, and neither path is a substitute for the active Bedrock/Neptune pilot's source and quality gates.

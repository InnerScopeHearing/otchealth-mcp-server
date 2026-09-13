# Opaque identifier retrieval

The fast OpenSearch path recognizes a narrow single opaque identifier: an uppercase alphanumeric token of8-64 characters containing a digit, or an existing canonical scoped-ID shape. Ordinary language queries are unchanged.

Within already returned authorized search candidates, a literal boundary match is preserved before grouping chunks by parent and trimming results. Long evidence uses a bounded snippet around the token. The explicit match survives ordinary operational-message demotion. Brain federation preserves that candidate before its existing retraction filtering, and reports `identifier-match` instead of mislabeling it as a direct document fetch. Canonical direct-ID fetches retain `direct-id` and take precedence.

This does not bypass room authorization, query a new data source, write records, change embeddings, or add a model call. It cannot recover an exact record absent from the underlying bounded search candidates. It does not prove a live indexing or mapping issue resolved. Post-deployment acceptance must repeat the reported technical identifier query and inspect the cited durable record.

Focused tests cover long-text evidence, token boundaries, unchanged natural queries, chunk grouping, operational demotion, federation, retraction and authorized-room behavior. The initial reviewed retrieval run passed56 tests with zero skips and TypeScript typechecking.

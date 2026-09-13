# Governed temporal assertion integration

This increment adds an internal assertion reader over the existing immutable relationship publication store. It does not provision a second store, ingest sources, expose a new MCP tool, change permissions, or activate a production policy.

## Authority boundary

`RelationshipPublicationDiscoveryService.assertionRecords` uses authenticated caller scope and server publication bindings. Every requested history must match its stored run and immutable artifact reference. The reader replays saved events through the existing resolver, checks fresh identity proofs, requires current source authorization, and rechecks policy before returning. Duplicate run IDs are rejected.

The adapter is a structural projection, not a semantic verifier. Only existing verifier-backed typed assertions with matching immutable witnesses can be represented as verified. Returned statements contain typed entity identifiers and predicates, not prepared source bodies. Source generation, byte spans, hashes, recorded time and unknown valid-time semantics remain explicit. Unsupported or inconsistent records are omitted rather than promoted.

## Corrections and coverage limits

Within the supported history format, supersession closes the old record's recorded-time interval. Ambiguous correction mappings abstain. The reader aggregates corrections across the selected inputs defensively, but the current durable producer accepts correction indices only within its local accepted batch. A requested external-history target is rejected before persistence with `resolution_batch_invalid`. This is not completed cross-history correction support.

The input is an explicit bounded set of histories, not an authoritative full-company inventory. An omitted record is not proof that a fact never existed. No caller should infer complete temporal coverage from an empty result. The internal reader is not yet connected to the general evidence-view query or a client-facing temporal question workflow.

## Verification

Paired-repository integration tests use the actual CTO durable adapter at `b722eac90dc58281ce0c9b238d3dc9858b132aba`. The focused reader and adapter run passed six tests with zero skips, including nonempty real projections, source and identity revocation, scope denial, policy races, artifact mismatch, tampering, duplicate histories and external-history correction rejection. Local typechecking passed.

Release still requires deterministic non-skipping CI coverage, exact-head review and ordinary full CI. Cross-client end-to-end temporal queries, producer support for cross-history corrections, generalized inferred assertions and activation against reviewed production bindings remain separate required work toward the eleven-capability objective.

# B17 secondary projection observability

Reviewed source-only improvement: memory_write returns primary and optional secondary backend/indexed booleans. Optional secondary failure is visible without raw secondary transport errors. Primary acceptance and durable indexing semantics stay unchanged; no repair job, permission, identity or provider fallback is added.

Root and independent reviewer verified29 focused tests and typecheck. Source/test SHA-256: ba64a6784bd66e824d99181b33d407daae56ac7a2a1280b2f1b7621e952d81a2 / 4b3968260a5b90f9b44321253ff0512f94a9f9606a0104dc4a03f36512e7eea7. Independent grouped final receipt SHA-25609ebc89bc6f9db81465526046a9c73bb382f6d8bc4f744ee17ff7b0d74e045aa; original HOLD and closure history retained by conductor.

This is source acceptance only until exact immutable build and single-owner runtime promotion/readback. No live index repair or all-agent acceptance is claimed.

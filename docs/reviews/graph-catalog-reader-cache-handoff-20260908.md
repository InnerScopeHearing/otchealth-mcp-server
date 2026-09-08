# Graph catalog reader cache review handoff

Review target: local branch `claude/catalog-reader-cache-20260908`.

Exact PR319 base: `e4ba13ee62155a56a8556bfcb211579a79081105`.

Implementation commit before this receipt: `42a6c8f42f0f68300f1f1843501c887a97c339c5`.

This change leaves the graph catalog controller default disabled and does not alter its runtime authorization, cohort configuration, publication, admission, or currentness logic. Each controller request still authenticates the caller and resolves the current cohort before it can call the catalog reader. Every reader call still performs a fresh S3 HEAD.

The reader reuses parsed metadata only when all of these values exactly match a completed prior read through the same raw S3 adapter: object key, configured catalog source SHA-256, ETag, S3 version id including absence, content length, and raw Last-Modified. A cache miss uses If-Match and requires the GET ETag, version id, Last-Modified, and byte count to match the HEAD identity.

Ready cache limits are two entries, 8 MiB combined source size, and 20,000 combined rows. Any valid catalog above either per-entry limit is read normally but is not retained. At most two different catalog downloads can run at once per raw S3 adapter, with at most 32 queued identity loads. Calls for one unchanged identity coalesce to one GET and parse operation after their separate fresh HEAD calls.

Parsed rows, nested objects, arrays, the row array, and the returned catalog object are frozen before publication. A changed HEAD identity bypasses old entries immediately. Transport failure, invalid JSONL, partial stream failure, cancellation, and GET identity drift do not publish a cache entry. Cache state is scoped by raw S3 adapter, so one adapter cannot reuse rows loaded through another.

The authorization regression first warms the catalog through an authenticated CFO request. A different synthetic caller is then denied without reaching HEAD or cached rows. Disabling the synthetic cohort is also checked after warming and prevents both HEAD and cached access.

Run from the repository root in PowerShell:

```powershell
& 'C:\Users\matth\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test --import tsx src/server/graph-catalog-reader.test.ts src/server/graph-catalog-controller.test.ts src/server/graph-catalog-planner.test.ts
& '.\node_modules\.bin\tsc.cmd' -p tsconfig.json --noEmit
git diff --check
```

Observed result: 19 tests passed, TypeScript passed, and `git diff --check` passed.

The synthetic request-count receipt is [graph-catalog-reader-cache-synthetic-receipt-20260908.json](./graph-catalog-reader-cache-synthetic-receipt-20260908.json).

Limitations:

- The measurement used only generated metadata rows and an in-process raw S3 fixture.
- It does not measure wall-clock production latency, CPU, memory use, AWS transfer, or cost.
- Catalogs above 8 MiB or 20,000 rows are not retained after a call.
- The cache is process local. Separate gateway replicas do not share it.
- A fresh HEAD remains required for every request.
- No live company catalog, source body, AWS endpoint, model, deployment, or production gateway was accessed.

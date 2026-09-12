# Graph catalog throughput investigation, 2026-09-12

## Scope

This is a code-only investigation of the CFO Graph backfill path. No gateway calls,
source reads, source content, worker mutations, admission requests, or model calls were
performed. The inspected source runtime is the immutable checkout at
`C:/cto-cfo-runtime-ad6d011188308a2ed`. The gateway change is on
`claude/graph-catalog-throughput-20260912` in `C:/wt/gateway-slot-v2`.

## Finding

The source runtime selects one bounded page, then publishes each selected document
individually. In `tools/neptune-trial/catalog-controller/controller.mjs`,
`prepareBatch` calls `catalogPager.readPage` once at line 136, reads one durable version
record per page item at line 197, and calls `sourceSnapshots.publish` once per item at
line 208. Pending records are reread sequentially, up to the controller cursor bound,
at lines 161 and 173. These are bounded by the existing page and pending limits.

The gateway reloaded and reparsed the full catalog for each of those route calls when the
catalog exceeded the reader cache caps. The materialized catalog described for the
trial, about 22 MiB and 47,000 rows, was above the old 8 MiB and 20,000 row limits.
The reader therefore repeated a full streamed JSONL parse in
`src/server/graph-catalog-reader.ts` at lines 359-400 for every catalog call.

The controller has additional repeated linear scans after parsing:

* `src/server/graph-catalog-controller.ts:94-101` filters every row through the
  caller's source scope on every `catalog` call.
* `src/server/graph-catalog-controller.ts:105` scans filtered rows for the matching
  source path in every currentness check. This is used by admission and
  `/source-current`.
* `src/server/graph-catalog-controller.ts:190` scans filtered rows during every
  `/publish` revalidation.
* `src/server/graph-catalog-controller.ts:186-187` scan rows for targeted page and
  targeted proposal lookup.
* `src/server/graph-catalog-controller.ts:196-198` scans at most the configured active
  admission bound and rereads each active record. This is small, currently bounded to
  two, but it remains repeated control-plane I/O.

Static counts from the inspected files were 425 lines and 10 hotspot matches in the
source controller, 222 lines and 36 hotspot matches in the gateway controller, and
513 lines and 4 parser or reader hotspot matches in the gateway reader. These are code
counts, not production telemetry or a corpus census.

## Implemented bounded fix

`src/server/graph-catalog-reader.ts` now caches one verified parsed catalog when it is
at most 24 MiB and 50,000 rows. The one-entry limit bounds retained catalog memory and
prevents old and new revisions from accumulating. The cache identity still includes
the key, reviewed source hash, ETag, version ID, byte size, and Last-Modified value.

Every caller still performs a fresh HEAD before cache lookup. The existing GET
If-Match, exact GET response identity check, post-download HEAD, content hash pin,
materialization source version check, and caller content pin remain intact. A changed
object receives a new identity or fails closed. A caller with a revoked or otherwise
invalid current S3 authority must still pass the fresh HEAD through its current
adapter. Cache state is held in a WeakMap keyed by the raw S3 authority adapter, so
distinct adapters cannot share entries.

This change targets the repeated GET and JSONL parse cost. It intentionally does not
add a row index or cache the source-scope filtered view. The remaining linear filters
and row scans above are the next bounded optimization candidate, subject to preserving
source policy isolation and currentness checks.

## Tests

The reader suite passes 18 tests, including the new 47,000-row, over-20 MiB synthetic
case. That regression observes one GET and parse followed by fresh HEAD-only reuse, and
confirms all 47,000 rows remain available. TypeScript typecheck also passes.

Validation was run with the bundled Node and local `tsx` loader because `npm` is not
available in this Windows runtime. The first `pnpm` attempt tried to recreate a shared
temporary dependency directory and was stopped by pnpm's build-script policy; no
repository dependency files were retained from that attempt.

Commands used:

```text
node --import file:///C:/wt/gateway-slot-v2/node_modules/tsx/dist/loader.mjs --test C:/wt/gateway-slot-v2/src/server/graph-catalog-reader.test.ts
node C:/wt/gateway-slot-v2/node_modules/typescript/bin/tsc -p C:/wt/gateway-slot-v2/tsconfig.json --noEmit
```

No full gateway suite or production acceptance is claimed by this report.

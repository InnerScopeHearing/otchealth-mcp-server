/**
 * OpenSearch memory BACKFILL / RECONCILER — the self-healing half of "the brain's continuous
 * writer," alongside the write-time dual-write in `opensearch-write.ts` / `index.ts`'s
 * `indexMemory()`.
 *
 * ===================== WHY BOTH A WRITER AND A BACKFILL EXIST =====================
 * `indexMemory()` (src/search/index.ts) makes every NEW memory searchable the instant it is
 * written — that closes the ongoing-freshness gap. It does nothing for memories that were already
 * written and never got picked up, which on Azure was every mutating tool call before PR #225
 * landed the write-through (2026-08-15), and is also the shape of any future gap: a deploy that
 * temporarily disables indexing, a network partition between the gateway and OpenSearch, a
 * `SEARCH_DUAL_WRITE` window where one side silently failed (dual-write reports the secondary's
 * failure but does not retry it). Azure's answer to this class of gap was ITS search service, not
 * this repo: 18 native Cosmos-change-feed / Blob pull-indexers that re-scanned the source of truth
 * on a schedule and healed anything the write-through missed. OpenSearch has no equivalent managed
 * pull connector for a Cosmos/Postgres source, so this module is that missing half, implemented in
 * application code: pull rows NEWER than the index's current watermark and index them.
 *
 * Designed to run BOTH as a one-time catch-up (an explicit `--since`, e.g. the exact moment a gap
 * started) and as a periodic reconciler (no `--since`: auto-detects the index's current newest
 * document and catches up from there). Idempotent by construction — see "WHY `index`, NOT
 * `update`" below — so re-running it, on a schedule or by hand, is always safe.
 *
 * ===================== SOURCE OF TRUTH: THE STORE DISPATCHER, NOT COSMOS =====================
 * Reads through `agentstate/store.ts` (`STATE_BACKEND`-dispatched: `cosmos` today, `postgres` once
 * that migration lands), never `agentstate/cosmos.ts` directly — this repo's own
 * `agentstate-dependency-guard.test.ts` enforces exactly that import discipline fleet-wide, and a
 * hardcoded Cosmos import here would silently stop working the day `STATE_BACKEND` flips. `queryDocs`
 * is dependency-injected (see `BackfillDeps`) purely so this module's orchestration logic is testable
 * without a live Cosmos/Postgres — the DEFAULT is always the real dispatcher export.
 *
 * ===================== ROOM SCOPE: `memory-exec` ONLY, AND WHY =====================
 * Every gateway call site that writes a Cosmos `memory` record and indexes it (`memory_write`,
 * `checkpoint`, the auto-journal in `safety/journal.ts`, `memory_remember`'s Cosmos-adjacent
 * write-through) calls `indexMemory()` WITHOUT an `index` argument, which defaults to `memory-exec`
 * (see `opensearch-write.ts` / `azure/search-write.ts`). So `memory-exec` is the entire target
 * surface of the Cosmos/Postgres `memory` container today — there is no per-agent or per-ring room
 * routing to replicate here. (The OTHER frozen rooms named in the AWS-cutover incident —
 * `commons-<agent>-memory`, `finance-cfo-memory`, `legal-personal-memory` — are populated by a
 * completely different pipeline: the Azure-Blob-backed `mem.mjs` CLI ledgers reindexed by
 * `otchealth-claude-tools/skills/kb-memory/semantic.mjs` and `skills/ring-memory-index/`, which
 * never touch Cosmos/Postgres at all. That pipeline needs its OWN OpenSearch port; see this PR's
 * description / the claude-tools side of this change for that half.) `index` stays a parameter
 * rather than a hardcoded constant so a future room-routing change does not require rewriting this
 * file, but `memory-exec` is the only value any real caller needs today.
 *
 * ===================== THE CROSS-PARTITION ORDERING HAZARD, AND WHY THIS SIDESTEPS IT =====================
 * The `memory` container is partitioned on `/agent`. `agentstate/store.ts`'s cross-partition
 * `queryDocs` (no `pk` given) fans a query out to every partition-key range and CONCATENATES the
 * per-range result arrays — each range's own rows honour `ORDER BY c.created_at ASC` internally, but
 * the merged array is NOT globally time-ordered across ranges. A cursor built from "the last row of
 * the merged batch" is therefore unsafe in general: it could permanently skip a still-unseen row in
 * an earlier-processed range whose timestamp happens to be newer than the cursor. This module does
 * NOT use that cursor. Instead it issues exactly ONE query per run, with a generous `max` (default
 * 5000 — comfortably above any realistic catch-up backlog; the whole `memory-exec` room, accumulated
 * over the room's entire lifetime, is ~7-8k docs), and self-detects the one case where that
 * assumption could be wrong: `fetched >= max` sets `truncated: true` in the result rather than
 * silently claiming completeness (mirroring the required, non-optional `truncated` field convention
 * `azure/search-write.ts`'s deindex path already established for exactly this "don't let 'ran without
 * error' be mistaken for 'ran to completion'" failure class). A caller that gets `truncated: true`
 * should re-run with `--since` set to this run's own `since` output advanced by the result, or narrow
 * the window with `--agent` (below). Passing `--agent` scopes the query to a single partition
 * (`opts.pk`), where continuation-token pagination inside `agentstate/store.ts` IS a stable, correctly
 * globally-ordered stream — the fully rigorous option for a cautious re-run or a future per-agent
 * scheduled sweep, at the cost of one run per agent instead of one run total.
 *
 * ===================== WHY `index`, NOT `update`, FOR THE BULK WRITE =====================
 * OpenSearch's `_bulk` API's `index` action REPLACES a document wholesale; `update` partially merges
 * named fields, leaving everything else (including a previously-written `contentVector`) untouched.
 * The trap: a bulk `index` action that omits the vector field on a document that already has one
 * DESTROYS that embedding. This module never hits that trap because it never sends a partial
 * document — every row is embedded fresh (see "always re-embed" below) and passed through
 * `buildOpenSearchMemoryDoc`, the SAME complete-document builder the live write-through path uses, so
 * every bulk `index` action is a full, self-consistent replacement, identical in shape to what a
 * single-document PUT would have written. `update` is not used anywhere here: there is no scenario in
 * this module where writing a partial document is ever the right thing to do.
 *
 * ===================== WHY THIS ALWAYS RE-EMBEDS (NEVER LOOKS FOR A STORED VECTOR) =====================
 * `MemoryRecord` (agentstate/memory.ts) carries no embedding field — Cosmos/Postgres store the
 * verbatim text, not a vector, so there is nothing to reuse. Every backfilled row is embedded via
 * the SAME `embed`/`embedBatch` path (`azure/foundry.ts`) the live write-through and every other
 * indexer in this repo uses, dispatched on `EMBEDDINGS_PROVIDER` — never a second embedding path,
 * never Bedrock Titan/Cohere (see `config/env.ts`'s `EMBEDDINGS_PROVIDER` doc comment: a different
 * model's vectors are silently incomparable to the ones already in the index; that failure produces
 * no error, only quietly wrong relevance). A batch-embed failure falls back to per-item `embed()`
 * calls (which return `null`, never throw, on their own failure) — the same fallback
 * `azure/foundry.ts`'s own `embedBatch` doc comment recommends verbatim — so one bad row in a batch
 * degrades that row to keyword-only indexing rather than losing the whole batch.
 *
 * ===================== FAIL-OPEN AT THE ROW LEVEL, LOUD AT THE RUN LEVEL =====================
 * A single malformed Cosmos/Postgres row (missing `id`/`agent`/`text`) is dropped by
 * `normalizeRow` rather than aborting the run. A single bulk-item failure is counted and its first
 * few reasons surfaced in `errors`, but does not stop the remaining items. The RUN as a whole,
 * however, is not fail-open the way the hot-path writer is: this is an operator-invoked
 * reconciliation tool, not a request-serving path, so its whole point is to surface "how much did
 * NOT make it" rather than to swallow that the way a fire-and-forget write-through must.
 */
import { loadEnv } from '../config/env.js';
import { queryDocs as realQueryDocs } from '../agentstate/store.js';
import { embed as realEmbed, embedBatch as realEmbedBatch } from '../azure/foundry.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
import { resolveAwsCredentials, signRequest } from './sigv4.js';
import { buildOpenSearchMemoryDoc } from './opensearch-write.js';

const DEFAULT_INDEX = 'memory-exec';
const DEFAULT_MAX = 5000;
const DEFAULT_EMBED_BATCH_SIZE = 16; // mirrors ring-memory-index's EMBED_BATCH
const DEFAULT_BULK_BATCH_SIZE = 48; // mirrors ring-memory-index's PUSH_BATCH
/** Bulk payloads (up to DEFAULT_BULK_BATCH_SIZE docs x 3072-dim float vectors) are much larger than
 *  a typical query/write call in this repo -- give the transport more time than fetchWithBudget's
 *  8s default before declaring a stall. Bulk index-by-id is idempotent (replay-safe), so a retry is
 *  correct, not just convenient. */
const BULK_TIMEOUT_MS = 30000;
const BULK_RETRIES = 1;
const MAX_ERRORS_KEPT = 10;

// ============================ pure: row shape ============================

/** The subset of a Cosmos/Postgres `memory` document this module needs. Field names match
 *  `agentstate/memory.ts`'s `MemoryRecord` exactly (`kind`, `created_at`) -- NOT the index document's
 *  field names (`type`, `ts`); `toIndexInput` below does that translation, mirroring the same mapping
 *  every write-through call site (`checkpoint.ts`, `journal.ts`, `memory-write.ts`) already applies
 *  inline (`type: record.kind, ts: record.created_at`). */
export interface MemoryRow {
  id: string;
  agent: string;
  kind: string;
  text: string;
  tags: string[];
  created_at: string;
}

/**
 * Defensively validate + coerce one raw Cosmos/Postgres document into a `MemoryRow`, or `null` if it
 * is not a usable memory record. FAIL-SAFE PER ROW (mirrors `ring-memory-index.mjs`'s `indexRing`
 * doc comment: "one row's failure never blocks the others") -- a malformed row is skipped, not
 * thrown, so one bad document in a large batch cannot abort the whole run. Pure, exported for tests.
 */
export function normalizeRow(raw: Record<string, unknown>): MemoryRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw['id'];
  const agent = raw['agent'];
  const kind = raw['kind'];
  const text = raw['text'];
  const created_at = raw['created_at'];
  if (typeof id !== 'string' || !id) return null;
  if (typeof agent !== 'string' || !agent) return null;
  if (typeof kind !== 'string' || !kind) return null;
  if (typeof text !== 'string' || !text) return null;
  if (typeof created_at !== 'string' || !created_at) return null;
  const tagsRaw = raw['tags'];
  const tags = Array.isArray(tagsRaw) ? tagsRaw.filter((t): t is string => typeof t === 'string') : [];
  return { id, agent, kind, text, tags, created_at };
}

/** MemoryRow -> the shape `buildOpenSearchMemoryDoc` expects (the field-name translation described
 *  in the module doc comment). Pure. */
export function toIndexInput(row: MemoryRow, vector: number[] | null): Parameters<typeof buildOpenSearchMemoryDoc>[0] {
  return { agent: row.agent, id: row.id, type: row.kind, ts: row.created_at, tags: row.tags, text: row.text, vector };
}

// ============================ pure: bulk request/response shape ============================

/**
 * Build the `_bulk` NDJSON body for one batch of already-embedded rows. Uses the `index` action
 * (full replace), never `update` -- see the module doc comment's "WHY `index`, NOT `update`"
 * section. Reuses `buildOpenSearchMemoryDoc` (the exact same doc-shape builder the live write-through
 * path uses) so a backfilled document is byte-identical in shape to one written by
 * `indexMemoryNowOpenSearch`. Pure, exported for tests.
 */
export function rowsToBulkNdjson(rows: { row: MemoryRow; vector: number[] | null }[], index: string): string {
  const lines: string[] = [];
  for (const { row, vector } of rows) {
    const doc = buildOpenSearchMemoryDoc(toIndexInput(row, vector), index);
    lines.push(JSON.stringify({ index: { _index: index, _id: doc.id } }));
    lines.push(JSON.stringify(doc));
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export interface BulkOutcome {
  indexed: number;
  failed: number;
  /** First MAX_ERRORS_KEPT failure reasons, capped so one systemic failure mode does not flood the
   *  final report with near-identical lines. */
  errors: string[];
}

/**
 * Parse an OpenSearch `_bulk` response. A 2xx HTTP status does NOT mean every item succeeded --
 * `errors:true` in the body (with per-item status inside `items[]`) is how OpenSearch reports a
 * partial failure, mirroring the exact same 2xx-can-still-be-partial lesson `azure/search-write.ts`'s
 * `deleteChunkPage` already documents for Azure AI Search's own bulk endpoint. Pure, exported for
 * tests; never throws (a response that does not parse as expected counts as `failed` for every row
 * submitted, via the caller passing `requested` -- see `bulkIndex` below).
 */
export function parseBulkResponse(json: unknown, requested: number): BulkOutcome {
  const body = json as { errors?: boolean; items?: Array<Record<string, { status?: number; error?: { type?: string; reason?: string } }>> } | null;
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!body || !Array.isArray(body.items)) {
    return { indexed: 0, failed: requested, errors: ['malformed _bulk response: missing "items" array'] };
  }
  let indexed = 0;
  const errors: string[] = [];
  for (const item of items) {
    const result = item['index'] ?? item['create'] ?? item['update'] ?? Object.values(item)[0];
    const status = result?.status ?? 0;
    if (status >= 200 && status < 300) {
      indexed += 1;
    } else if (errors.length < MAX_ERRORS_KEPT) {
      errors.push(`status=${status} ${result?.error?.type ?? ''} ${result?.error?.reason ?? ''}`.trim());
    }
  }
  return { indexed, failed: items.length - indexed, errors };
}

// ============================ IO: signed OpenSearch calls ============================

function openSearchHost(): string {
  return (loadEnv().OPENSEARCH_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

async function signedFetch(
  method: string,
  path: string,
  body: string | undefined,
  opts: { timeoutMs?: number; retries?: number; contentType?: string } = {},
): Promise<Response> {
  const e = loadEnv();
  const host = openSearchHost();
  if (!host) throw new Error('OPENSEARCH_ENDPOINT not configured');
  const credentials = await resolveAwsCredentials();
  if (!credentials) throw new Error('opensearch credentials unavailable');
  const signed = signRequest({
    method,
    host,
    path,
    body,
    region: e.OPENSEARCH_REGION || 'us-east-1',
    service: 'es',
    credentials,
    // content-type must be a SIGNED header (see opensearch-write.ts's identical warning): send
    // exactly signed.headers below, never a second differently-cased copy alongside it.
    ...(body !== undefined && opts.contentType ? { extraHeaders: { 'content-type': opts.contentType } } : {}),
  });
  return fetchWithBudget(
    `https://${host}${path}`,
    { method, headers: signed.headers, ...(body !== undefined ? { body } : {}) },
    { timeoutMs: opts.timeoutMs, retries: opts.retries },
  );
}

/**
 * Index one already-built `_bulk` NDJSON batch. Never throws -- any transport failure or malformed
 * response is folded into `{indexed:0, failed:requested, errors:[...]}` so one bad batch cannot take
 * down the rest of a multi-batch run.
 */
export async function bulkIndex(ndjson: string, requested: number): Promise<BulkOutcome> {
  if (!ndjson) return { indexed: 0, failed: 0, errors: [] };
  try {
    const r = await signedFetch('POST', '/_bulk', ndjson, { timeoutMs: BULK_TIMEOUT_MS, retries: BULK_RETRIES, contentType: 'application/x-ndjson' });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      return { indexed: 0, failed: requested, errors: [`_bulk ${r.status}: ${body}`] };
    }
    return parseBulkResponse(await r.json(), requested);
  } catch (e) {
    return { indexed: 0, failed: requested, errors: [(e as Error).message] };
  }
}

/**
 * Auto-detect the index's current freshness watermark: the `ts` of its newest document. Tries a
 * sort on `ts` directly first; on any failure (most likely an OpenSearch "fielddata disabled on
 * text fields" error if the live mapping did not give `ts` a `keyword` sub-field), retries once
 * against `ts.keyword` before giving up. Returns `null` when the index is empty, absent (404), or
 * unreachable after both attempts -- callers must treat `null` as "cannot auto-detect," never as
 * "since the beginning of time" (see `resolveSince` below).
 */
export async function fetchIndexMaxTs(index: string): Promise<string | null> {
  const body = (field: string) => JSON.stringify({ size: 1, _source: ['ts'], sort: [{ [field]: { order: 'desc' } }] });
  const parse = async (r: Response): Promise<string | null> => {
    const j = (await r.json()) as { hits?: { hits?: Array<{ _source?: { ts?: unknown } }> } };
    const ts = j.hits?.hits?.[0]?._source?.ts;
    return typeof ts === 'string' && ts ? ts : null;
  };
  try {
    let r = await signedFetch('POST', `/${encodeURIComponent(index)}/_search`, body('ts'), { contentType: 'application/json' });
    if (r.status === 404) return null;
    if (!r.ok) r = await signedFetch('POST', `/${encodeURIComponent(index)}/_search`, body('ts.keyword'), { contentType: 'application/json' });
    if (!r.ok) return null;
    return await parse(r);
  } catch {
    return null;
  }
}

// ============================ orchestration ============================

export interface BackfillDeps {
  queryDocs: typeof realQueryDocs;
  embed: typeof realEmbed;
  embedBatch: typeof realEmbedBatch;
}

const defaultDeps: BackfillDeps = { queryDocs: realQueryDocs, embed: realEmbed, embedBatch: realEmbedBatch };

export interface BackfillOptions {
  /** Target OpenSearch index. Default 'memory-exec' -- see the module doc comment's "ROOM SCOPE". */
  index?: string;
  /** ISO-8601 cutoff: only rows with `created_at > since` are fetched. Omit to auto-detect from the
   *  index's current newest document (fetchIndexMaxTs) -- the right choice for a scheduled/repeat
   *  reconciler run. Required to succeed if auto-detection returns null (empty/unreachable index):
   *  this module refuses to silently backfill "since the beginning of time." */
  since?: string;
  /** Row cap for the single query this run issues. Default 5000. See the module doc comment's
   *  cross-partition-ordering section for why this is a single generous fetch, not a cursor loop. */
  max?: number;
  /** Scope to one agent's partition (Cosmos `pk`). Optional; when set, sidesteps the cross-partition
   *  merge-ordering caveat entirely (a single-partition query IS a stable, correctly time-ordered
   *  continuation stream) -- the fully rigorous choice for a cautious re-run of a `truncated:true`
   *  result, or a future per-agent scheduled sweep. */
  agent?: string;
  embedBatchSize?: number;
  bulkBatchSize?: number;
  /** Preview only: fetch and report what WOULD be indexed, embed and write nothing. */
  dryRun?: boolean;
}

export interface BackfillResult {
  index: string;
  since: string;
  fetched: number;
  indexed: number;
  failed: number;
  /** True when `fetched` hit the `max` cap -- the fetch may not be complete. Re-run with `since` set
   *  to this run's newest observed `created_at`, or narrow with `agent`. REQUIRED (not optional), so
   *  a future call site cannot forget to check it and silently treat an incomplete run as done --
   *  mirrors `azure/search-write.ts`'s `DeindexResult.truncated` convention exactly, and for the
   *  identical reason. */
  truncated: boolean;
  errors: string[];
  dryRun: boolean;
  /** dryRun only: a small preview of what would be indexed. */
  preview?: Array<{ agent: string; id: string; kind: string; created_at: string }>;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Embed a batch of rows' text, falling back to per-item `embed()` when `embedBatch` throws for that
 * chunk (mirrors `azure/foundry.ts`'s own doc comment: "callers that want a same-shape-as-embed
 * best-effort fallback should catch and fall back to per-item embed() calls, exactly as the existing
 * per-call embed() sites already do"). Returns one vector-or-null per input row, same order.
 */
async function embedRows(rows: MemoryRow[], deps: BackfillDeps, embedBatchSize: number): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = [];
  for (const part of chunk(rows, embedBatchSize)) {
    try {
      const vecs = await deps.embedBatch(part.map((r) => r.text));
      if (vecs) {
        out.push(...vecs);
        continue;
      }
      out.push(...part.map(() => null)); // embeddings unconfigured -- degrade, never drop the row
    } catch {
      // Batch call failed outright -- fall back to per-item embed(), which itself never throws.
      for (const r of part) {
        try {
          out.push(await deps.embed(r.text));
        } catch {
          out.push(null);
        }
      }
    }
  }
  return out;
}

/**
 * Run one backfill pass. See the module doc comment for the full design rationale. Never throws --
 * every failure mode (store unreachable, OpenSearch unreachable, malformed rows) is reflected in the
 * returned result's counts/errors rather than as an exception, so a scheduled caller can always log
 * and move on rather than crash a cron.
 */
export async function runBackfill(opts: BackfillOptions = {}, deps: BackfillDeps = defaultDeps): Promise<BackfillResult> {
  const index = opts.index || DEFAULT_INDEX;
  const max = opts.max ?? DEFAULT_MAX;
  const embedBatchSize = opts.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
  const bulkBatchSize = opts.bulkBatchSize ?? DEFAULT_BULK_BATCH_SIZE;
  const dryRun = Boolean(opts.dryRun);

  let since = opts.since;
  if (!since) {
    since = (await fetchIndexMaxTs(index)) ?? undefined;
    if (!since) {
      return {
        index,
        since: '',
        fetched: 0,
        indexed: 0,
        failed: 0,
        truncated: false,
        dryRun,
        errors: [
          `cannot auto-detect a watermark for "${index}" (empty, absent, or unreachable) -- pass an explicit --since so this run does not silently backfill the entire room's history`,
        ],
      };
    }
  }

  let rawRows: Record<string, unknown>[];
  try {
    rawRows = await deps.queryDocs(
      'memory',
      "SELECT * FROM c WHERE c.type = 'memory' AND c.created_at > @since ORDER BY c.created_at ASC",
      [{ name: '@since', value: since }],
      { max, ...(opts.agent ? { pk: opts.agent } : {}) },
    );
  } catch (e) {
    return { index, since, fetched: 0, indexed: 0, failed: 0, truncated: false, dryRun, errors: [`memory-store query failed: ${(e as Error).message}`] };
  }

  const rows = rawRows.map(normalizeRow).filter((r): r is MemoryRow => r !== null);
  const skipped = rawRows.length - rows.length;
  const truncated = rawRows.length >= max;

  if (dryRun) {
    return {
      index,
      since,
      fetched: rows.length,
      indexed: 0,
      failed: 0,
      truncated,
      dryRun: true,
      errors: skipped ? [`${skipped} row(s) skipped: missing/malformed required fields`] : [],
      preview: rows.slice(0, 5).map((r) => ({ agent: r.agent, id: r.id, kind: r.kind, created_at: r.created_at })),
    };
  }

  if (rows.length === 0) {
    return { index, since, fetched: 0, indexed: 0, failed: 0, truncated, dryRun: false, errors: skipped ? [`${skipped} row(s) skipped: missing/malformed required fields`] : [] };
  }

  const vectors = await embedRows(rows, deps, embedBatchSize);
  const withVectors = rows.map((row, i) => ({ row, vector: vectors[i] }));

  let indexed = 0;
  let failed = 0;
  const errors: string[] = skipped ? [`${skipped} row(s) skipped: missing/malformed required fields`] : [];
  for (const part of chunk(withVectors, bulkBatchSize)) {
    const ndjson = rowsToBulkNdjson(part, index);
    const outcome = await bulkIndex(ndjson, part.length);
    indexed += outcome.indexed;
    failed += outcome.failed;
    for (const e of outcome.errors) if (errors.length < MAX_ERRORS_KEPT) errors.push(e);
  }

  return { index, since, fetched: rows.length, indexed, failed, truncated, dryRun: false, errors };
}

/**
 * OpenSearch memory WRITE path — the missing half of the search-backend migration.
 *
 * WHY THIS EXISTS. `src/search/index.ts` dispatches READS on `SEARCH_BACKEND`, but exported only
 * `hybridSearch` and `getDocumentByKey`. Every WRITE went straight to `src/azure/search-write.ts`
 * (Azure AI Search only) from six production call sites: memory_remember, checkpoint, the
 * auto-journal that fires on every successful mutating tool call, shadow-eval, and the two legal
 * blob de-index paths.
 *
 * So with `SEARCH_BACKEND=opensearch`, reads resolve against OpenSearch while writes land in Azure:
 * an agent saves a memory, the save reports success, and neither that agent nor any other can ever
 * recall it. The fleet presents as amnesia rather than as an error, because `search-write.ts` is
 * deliberately fail-open ("indexing is a CONVENIENCE on top of the durable store") and returns
 * `{indexed:false, reason}` instead of throwing. Nothing surfaces. That is the single reason the
 * DNS cutover was not safe.
 *
 * DOC SHAPE. Deliberately mirrors `buildMemoryDoc` in the Azure writer, minus `@search.action`
 * (an Azure Search bulk-protocol directive with no OpenSearch meaning; the action is expressed by
 * the HTTP verb instead). Two things MUST stay aligned or a write is silently unreadable:
 *   - The document `_id` is `memoryDocId(agent, id)`, identical to Azure's key, because
 *     `getDocumentByKey` fetches `/{index}/_doc/{key}` by exactly that value.
 *   - The vector field name is per-room, via `vectorFieldFor` — chunked doc rooms index
 *     `text_vector`, flat memory rooms index `contentVector`. Writing the wrong field name
 *     produces a document that is keyword-findable but invisible to vector recall, which is the
 *     hardest class of bug to notice.
 *
 * FAIL-OPEN, matching the Azure writer exactly. A memory write must never fail because an index was
 * unreachable; the durable store is the source of truth and the index is a projection of it. Every
 * failure path returns `{indexed:false, reason}` and this module never throws.
 */
import { loadEnv } from '../config/env.js';
import { embed } from '../azure/foundry.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
import { resolveAwsCredentials, signRequest } from './sigv4.js';
import { vectorFieldFor } from './opensearch.js';
import { memoryDocId, type IndexResult } from '../azure/search-write.js';

/** Mirrors MAX_TEXT in the Azure writer (and semantic.mjs) so a memory is truncated identically
 *  regardless of which backend stores it. Divergence here would make the two copies differ. */
const MAX_TEXT = 16000;

export interface MemoryWriteInput {
  agent: string;
  id: string;
  type?: string;
  ts?: string;
  tags?: string[];
  text: string;
  index?: string;
  /** Same three-state contract as the Azure writer: `undefined` => embed here; an array => use it;
   *  `null` => an upstream embed already failed, index without a vector and do NOT retry. */
  vector?: number[] | null;
}

/**
 * Build the OpenSearch document body. Pure and exported so the field mapping is unit-testable
 * without a live cluster — the vector field name in particular is a silent-failure risk.
 */
export function buildOpenSearchMemoryDoc(
  input: MemoryWriteInput & { vector: number[] | null },
  index: string,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: memoryDocId(input.agent, input.id),
    agent: input.agent,
    type: input.type || '',
    ts: input.ts || '',
    // Azure stores tags as a comma-joined string; keep the identical representation so a document
    // read back from either backend looks the same to every consumer.
    tags: (input.tags || []).join(', '),
    text: (input.text || '').slice(0, MAX_TEXT),
  };
  // A doc with no vector is still fully keyword-searchable -- degrade, never drop.
  if (input.vector) doc[vectorFieldFor(index)] = input.vector;
  return doc;
}

/**
 * Index one memory into OpenSearch immediately. FAIL-OPEN: never throws.
 *
 * `refresh=wait_for` is deliberate. OpenSearch refreshes on an interval by default, so a document
 * written and then immediately searched for is normally NOT found yet. Every consumer here writes a
 * memory and may recall it moments later in the same agent turn, and an eventually-consistent
 * "your memory does not exist yet" is indistinguishable from the amnesia bug this module exists to
 * fix. Waiting for the refresh costs latency on the write, which is the correct trade for a
 * fire-and-forget projection.
 */
export async function indexMemoryNowOpenSearch(input: MemoryWriteInput): Promise<IndexResult> {
  const index = input.index || 'memory-exec';
  const docId = memoryDocId(input.agent, input.id);
  try {
    const e = loadEnv();
    const host = (e.OPENSEARCH_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!host) return { indexed: false, reason: 'OPENSEARCH_ENDPOINT not configured', docId };

    const credentials = await resolveAwsCredentials();
    if (!credentials) return { indexed: false, reason: 'opensearch credentials unavailable', docId };

    let vector: number[] | null;
    if (input.vector !== undefined) {
      vector = input.vector;
    } else {
      try {
        vector = await embed(input.text);
      } catch {
        vector = null;
      }
    }

    const bodyStr = JSON.stringify(buildOpenSearchMemoryDoc({ ...input, vector }, index));
    // PUT to an explicit _id is an upsert: it creates or fully replaces. That matches the Azure
    // writer's `mergeOrUpload` closely enough for these documents, every field of which is rewritten
    // on each write, so there is no partial-merge case to preserve.
    const path = `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(docId)}`;
    const query = 'refresh=wait_for';
    const signed = signRequest({
      method: 'PUT',
      host,
      path,
      query,
      body: bodyStr,
      region: e.OPENSEARCH_REGION || 'us-east-1',
      service: 'es',
      credentials,
    });
    // signRequest already SIGNS content-type when a body is present, so it is present in
    // signed.headers. Adding a second, differently-cased copy risks desyncing the signature from
    // what is actually sent -- send exactly the headers that were signed.
    const r = await fetchWithBudget(`https://${host}${path}?${query}`, {
      method: 'PUT',
      headers: signed.headers,
      body: bodyStr,
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      return { indexed: false, reason: `opensearch index ${r.status}: ${body}`, docId, vector: Boolean(vector) };
    }
    return { indexed: true, docId, vector: Boolean(vector) };
  } catch (e) {
    return { indexed: false, reason: (e as Error).message, docId };
  }
}

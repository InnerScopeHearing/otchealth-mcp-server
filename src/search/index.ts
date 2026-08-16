/**
 * Search backend dispatcher. `SEARCH_BACKEND` (src/config/env.ts, default 'azure') selects which
 * concrete implementation every wired caller's hybridSearch/getDocumentByKey/searchConfigured call
 * actually reaches:
 *   azure       -> src/azure/search.ts (Azure AI Search, otchealth-dataroom-search). DEFAULT.
 *   opensearch  -> src/search/opensearch.ts (Amazon OpenSearch, SigV4-signed).
 *
 * Default 'azure' is a PURE passthrough to the existing azure/search.ts functions -- byte-identical
 * behavior to every deploy before this file existed, for every caller that gets repointed at this
 * module. This file is inert until SEARCH_BACKEND is deliberately set to 'opensearch'.
 *
 * ALSO wired through this dispatcher: src/tools/kb/search-privileged.ts (kb_search_privileged).
 * An earlier revision deliberately left it pinned to Azure, reasoning that the file defining
 * INDEX_LANES / PERSONAL_LEGAL_RING -- the one thing keeping attorney-privileged personal-legal
 * documents out of the finance lane -- should not be touched at all. That was the safe default
 * while unreviewed, but pinning it meant privileged rooms would go dark the moment Azure is
 * retired, while every other room kept working. Repointing it is ring-NEUTRAL by construction:
 * that file's ring decision (isLaneAllowed) is evaluated BEFORE the search call and depends only
 * on (index, callerAgent), so hybridSearch() only ever receives an already-authorized index name.
 * INDEX_LANES, PERSONAL_LEGAL_RING, isLaneAllowed, and the ring-check-before-search ordering are
 * untouched -- only the import source changed. Locking tests in search-privileged.test.ts continue
 * to pin the lane matrix (notably that the cfo lane cannot reach legal-personal*).
 */
import { loadEnv } from '../config/env.js';
import * as azureSearch from '../azure/search.js';
import * as openSearchBackend from './opensearch.js';
import * as azureWrite from '../azure/search-write.js';
import * as openSearchWrite from './opensearch-write.js';
import type { KbHit, FetchedDocument, HybridSearchOptions } from '../azure/search.js';

export type { KbHit, FetchedDocument, HybridSearchOptions } from '../azure/search.js';

function activeBackend(): 'azure' | 'opensearch' {
  return loadEnv().SEARCH_BACKEND;
}

export function searchConfigured(): boolean {
  return activeBackend() === 'opensearch' ? openSearchBackend.searchConfigured() : azureSearch.searchConfigured();
}

/** Room chunked/flat shape is a property of the DATA (same index names on both backends), not of
 *  which engine serves it -- always resolved from the single Azure-owned registry regardless of
 *  SEARCH_BACKEND. */
export function isChunkedRoom(index: string): boolean {
  return azureSearch.isChunkedRoom(index);
}

export async function hybridSearch(
  index: string,
  query: string,
  top: number,
  opts?: HybridSearchOptions,
): Promise<{ matches: KbHit[]; mode: string } | null> {
  return activeBackend() === 'opensearch'
    ? openSearchBackend.hybridSearch(index, query, top, opts)
    : azureSearch.hybridSearch(index, query, top, opts);
}

export async function getDocumentByKey(index: string, key: string): Promise<FetchedDocument | null> {
  return activeBackend() === 'opensearch'
    ? openSearchBackend.getDocumentByKey(index, key)
    : azureSearch.getDocumentByKey(index, key);
}

/**
 * ===================== THE WRITE HALF (2026-08-15) =====================
 *
 * Until this existed, this dispatcher exported READS ONLY. Every memory write went directly to
 * `src/azure/search-write.ts` from six production call sites, so setting `SEARCH_BACKEND=opensearch`
 * produced a system that READ from OpenSearch and WROTE to Azure: an agent saves a memory, the save
 * reports success, and nothing can ever recall it. Because the writer is deliberately fail-open,
 * that surfaced as fleet-wide amnesia rather than as an error. This was the blocking defect for the
 * AWS cutover.
 *
 * DUAL-WRITE is the migration primitive, controlled by `SEARCH_DUAL_WRITE`:
 *
 *   off (default)      write to whichever backend SEARCH_BACKEND selects. Pre-existing behavior.
 *   on                 write to BOTH. Reads still come from SEARCH_BACKEND alone.
 *
 * Dual-write exists so the cutover has no lossy instant. Turn it on BEFORE flipping reads and both
 * copies stay current, so the read flip carries no data gap and rolling back does not strand the
 * memories written while on the new backend. Turn it off only once the old backend is genuinely
 * retired. Without it, every memory written between the last bulk copy and the switch is lost to
 * whichever side you end up on -- and `memory-exec` is written continuously, so that window is
 * never empty.
 *
 * FAIL-OPEN AND NON-BLOCKING BY CONSTRUCTION. Both writers already swallow their own failures and
 * return `{indexed:false, reason}`. The two writes run CONCURRENTLY rather than in sequence so a
 * slow or unreachable secondary cannot add its latency to every memory write. The result reports
 * the PRIMARY backend's outcome, so no caller's success/failure semantics change; the secondary's
 * outcome rides along in `secondary` for observability. A secondary failure must never fail a write
 * the primary accepted.
 */
export interface DualIndexResult extends azureWrite.IndexResult {
  /** Which backend produced the returned outcome. */
  primary: 'azure' | 'opensearch';
  /** Present only when dual-write is on: the other backend's independent outcome. */
  secondary?: azureWrite.IndexResult & { backend: 'azure' | 'opensearch' };
}

export function dualWriteEnabled(): boolean {
  return loadEnv().SEARCH_DUAL_WRITE === true;
}

export async function indexMemory(input: {
  agent: string;
  id: string;
  type?: string;
  ts?: string;
  tags?: string[];
  text: string;
  index?: string;
  vector?: number[] | null;
}): Promise<DualIndexResult> {
  const primary = activeBackend();
  const writeTo = (backend: 'azure' | 'opensearch') =>
    backend === 'opensearch' ? openSearchWrite.indexMemoryNowOpenSearch(input) : azureWrite.indexMemoryNow(input);

  if (!dualWriteEnabled()) {
    return { ...(await writeTo(primary)), primary };
  }

  const other: 'azure' | 'opensearch' = primary === 'opensearch' ? 'azure' : 'opensearch';
  // Concurrent, not sequential: the secondary must not add latency to the primary's path.
  // allSettled rather than all, so a thrown (rather than returned) failure in either writer still
  // cannot reject this call -- the fail-open contract has to hold even if a writer regresses.
  const [primaryOutcome, secondaryOutcome] = await Promise.allSettled([writeTo(primary), writeTo(other)]);
  const base: azureWrite.IndexResult =
    primaryOutcome.status === 'fulfilled'
      ? primaryOutcome.value
      : { indexed: false, reason: `primary write threw: ${String(primaryOutcome.reason)}` };
  const secondary: azureWrite.IndexResult =
    secondaryOutcome.status === 'fulfilled'
      ? secondaryOutcome.value
      : { indexed: false, reason: `secondary write threw: ${String(secondaryOutcome.reason)}` };
  return { ...base, primary, secondary: { ...secondary, backend: other } };
}

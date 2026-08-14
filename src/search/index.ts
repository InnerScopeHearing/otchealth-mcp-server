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
 * NOT wired through this dispatcher: src/tools/kb/search-privileged.ts (kb_search_privileged), the
 * ring-gated privileged-room search path, which continues to import azure/search.ts DIRECTLY and
 * always uses Azure regardless of SEARCH_BACKEND. That file (and the INDEX_LANES /
 * PERSONAL_LEGAL_RING constants it defines) is the one thing keeping attorney-privileged
 * personal-legal documents out of the finance lane, and it is treated as read-only per this
 * migration's hard rules -- see the PR description for the explicit callout.
 */
import { loadEnv } from '../config/env.js';
import * as azureSearch from '../azure/search.js';
import * as openSearchBackend from './opensearch.js';
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

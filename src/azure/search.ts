/**
 * Shared hybrid retrieval over Azure AI Search (otchealth-dataroom-search).
 * Hybrid = BM25 keyword (search) + vector (contentVector via text-embedding-3-large) + 'sem'
 * semantic ranker, with graceful degradation to keyword-only on 400 / missing embeddings.
 * Read-only: uses AZURE_SEARCH_QUERY_KEY.
 */
import { loadEnv } from '../config/env.js';
import { embed } from './foundry.js';

const API_VERSION = '2023-11-01';

export interface KbHit {
  score: number | undefined;
  text: string;
  id: unknown;
}

function pickText(doc: Record<string, unknown>): string {
  for (const f of ['text', 'content', 'chunk', 'body', 'pageContent']) {
    if (typeof doc[f] === 'string' && (doc[f] as string).length) return doc[f] as string;
  }
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('@') || /vector/i.test(k)) continue;
    if (typeof v === 'string' && v.length > 40) return v;
  }
  return '';
}

export function searchConfigured(): boolean {
  const e = loadEnv();
  return Boolean(e.AZURE_SEARCH_ENDPOINT && e.AZURE_SEARCH_QUERY_KEY);
}

export async function hybridSearch(
  index: string,
  query: string,
  top: number,
): Promise<{ matches: KbHit[]; mode: string } | null> {
  const e = loadEnv();
  const ep = (e.AZURE_SEARCH_ENDPOINT || '').replace(/\/+$/, '');
  const key = e.AZURE_SEARCH_QUERY_KEY || '';
  if (!ep || !key) return null;

  let vector: number[] | null = null;
  try {
    vector = await embed(query);
  } catch {
    vector = null;
  }

  const body: Record<string, unknown> = {
    search: query,
    top,
    queryType: 'semantic',
    semanticConfiguration: 'sem',
    searchMode: 'any',
  };
  if (vector) body.vectorQueries = [{ kind: 'vector', vector, fields: 'contentVector', k: top }];

  const doSearch = async (b: Record<string, unknown>) =>
    fetch(`${ep}/indexes/${index}/docs/search?api-version=${API_VERSION}`, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });

  let r = await doSearch(body);
  if (r.status === 400) {
    r = await doSearch({ search: query, top, queryType: 'simple', searchMode: 'any' });
  }
  if (!r.ok) throw new Error(`search ${r.status}`);
  const j = (await r.json()) as { value?: Array<Record<string, unknown>> };
  const matches: KbHit[] = (j.value || []).map((d) => ({
    score: (typeof d['@search.rerankerScore'] === 'number' ? d['@search.rerankerScore'] : d['@search.score']) as number | undefined,
    text: pickText(d).slice(0, 1200),
    id: d['id'] ?? d['chunk_id'] ?? d['key'] ?? '',
  }));
  return { matches, mode: vector ? 'hybrid+semantic' : 'keyword' };
}

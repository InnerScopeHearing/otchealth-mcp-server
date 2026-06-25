/**
 * Semantic recall over the `memory-exec` Azure AI Search index (the write-through-indexed
 * shared exec brain). Read-only: uses a QUERY key, never the admin key. Ring-safe by
 * construction — memory-exec only ever contains the shared (non-PHI/non-MNPI/non-privileged)
 * exec feed, the same surface the gateway already exposes via the blob store.
 *
 * Inert without AZURE_SEARCH_ENDPOINT + AZURE_SEARCH_QUERY_KEY (callers fall back to keyword).
 */
import { loadEnv } from '../config/env.js';

const INDEX = 'memory-exec';
const API_VERSION = '2023-11-01';

export interface SemanticHit {
  id: string;
  ts: string;
  type: string;
  text: string;
  tags: string[];
  agent: string;
  score: number;
}

function cfg(): { ep: string; key: string } | null {
  const e = loadEnv();
  const ep = (e.AZURE_SEARCH_ENDPOINT || '').replace(/\/$/, '');
  const key = e.AZURE_SEARCH_QUERY_KEY || '';
  return ep && key ? { ep, key } : null;
}

export function semanticConfigured(): boolean {
  return cfg() !== null;
}

/**
 * Search the shared brain by meaning. Returns up to `limit` hits, optionally filtered to one
 * agent lane (filtered client-side so we never depend on the field being marked filterable).
 * Returns null when not configured so the caller can fall back to keyword search.
 */
export async function semanticSearch(
  query: string,
  agent: string | null,
  limit: number,
): Promise<SemanticHit[] | null> {
  const c = cfg();
  if (!c) return null;
  const top = agent ? Math.max(limit * 4, 40) : limit;
  const r = await fetch(`${c.ep}/indexes/${INDEX}/docs/search?api-version=${API_VERSION}`, {
    method: 'POST',
    headers: { 'api-key': c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ search: query, top, queryType: 'simple', searchMode: 'any' }),
  });
  if (!r.ok) throw new Error(`memory-exec search ${r.status}`);
  const j = (await r.json()) as { value?: Array<Record<string, unknown>> };
  let hits = (j.value || []).map((h) => ({
    id: String(h.id ?? ''),
    ts: String(h.ts ?? ''),
    type: String(h.type ?? ''),
    text: String(h.text ?? ''),
    tags: Array.isArray(h.tags) ? (h.tags as string[]) : [],
    agent: String(h.agent ?? ''),
    score: typeof h['@search.score'] === 'number' ? (h['@search.score'] as number) : 0,
  }));
  if (agent) hits = hits.filter((h) => h.agent === agent);
  return hits.slice(0, limit);
}

/**
 * kb_search — hybrid retrieval over the fleet's Azure AI Search knowledge indexes.
 *
 * Unlocks the large indexes that sat indexed-but-unreachable. RING-SAFE BY ALLOWLIST:
 *   - 'commons-company-journal'  -> all agents (commons; non-PHI/MNPI/privileged)
 *   - 'memory-exec'              -> all agents (the shared exec brain)
 *   - finance-* / legal-*        -> HARD RING BOUNDARY. NOT served on this externally-reachable
 *     gateway. Attorney-privileged (legal-*) and finance (finance-*) data stays on trusted-engine
 *     lanes and requires Matt + counsel sign-off to wire a gated path. We return a refusal, not data.
 *
 * Hybrid = BM25 keyword + vector (contentVector via text-embedding-3-large) + 'sem' semantic ranker.
 * Env: AZURE_SEARCH_ENDPOINT + AZURE_SEARCH_QUERY_KEY (read-only query key); embeddings via Foundry.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { loadEnv } from '../../config/env.js';
import { embed } from '../../azure/foundry.js';

const API_VERSION = '2023-11-01';
const OPEN_INDEXES = new Set(['commons-company-journal', 'memory-exec']);
const RING_GATED_PREFIXES = ['finance-', 'legal-'];

function pickText(doc: Record<string, unknown>): string {
  for (const f of ['text', 'content', 'chunk', 'body', 'pageContent']) {
    if (typeof doc[f] === 'string' && (doc[f] as string).length) return doc[f] as string;
  }
  // fallback: first long string field that isn't the vector
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('@') || /vector/i.test(k)) continue;
    if (typeof v === 'string' && v.length > 40) return v;
  }
  return '';
}

export function registerKbSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'kb_search',
      category: 'read',
      annotations: {
        title: 'Search a fleet knowledge index (hybrid)',
        description:
          'Hybrid (keyword + vector + semantic-ranker) search over a fleet Azure AI Search index. Open indexes: "commons-company-journal" (company journal/knowledge) and "memory-exec" (shared exec brain). Finance/legal indexes are ring-gated and refused on this gateway. Use to ground answers in the company knowledge base before asserting facts.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        index: z
          .string()
          .describe('Index name. Open: "commons-company-journal", "memory-exec". finance-*/legal-* are ring-gated.'),
        query: z.string().min(1).describe('Natural-language search query.'),
        top: z.number().int().min(1).max(25).optional().describe('Max results (default 6).'),
      },
      outputShape: {
        index: z.string(),
        matches: z.array(z.unknown()),
        count: z.number(),
        mode: z.string(),
        error: z.string().optional(),
      },
      handler: async (input) => {
        const index = input.index.trim();
        const top = input.top ?? 6;

        if (RING_GATED_PREFIXES.some((p) => index.startsWith(p))) {
          return {
            data: { index, matches: [], count: 0, mode: 'ring-gated', error: 'ring_gated' },
            summary: `"${index}" is ring-gated (finance/attorney-privileged). Not served on this gateway; requires a trusted-engine lane with Matt + counsel sign-off.`,
          };
        }
        if (!OPEN_INDEXES.has(index)) {
          return {
            data: { index, matches: [], count: 0, mode: 'unknown-index', error: 'unknown_index' },
            summary: `Unknown/closed index "${index}". Open indexes: ${[...OPEN_INDEXES].join(', ')}.`,
          };
        }

        const e = loadEnv();
        const ep = (e.AZURE_SEARCH_ENDPOINT || '').replace(/\/+$/, '');
        const key = e.AZURE_SEARCH_QUERY_KEY || '';
        if (!ep || !key) {
          return { data: { index, matches: [], count: 0, mode: 'unconfigured' }, summary: 'AI Search not configured.' };
        }

        let vector: number[] | null = null;
        try {
          vector = await embed(input.query);
        } catch {
          vector = null;
        }

        const body: Record<string, unknown> = {
          search: input.query,
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
          // degrade: drop semantic/vector, keyword only
          r = await doSearch({ search: input.query, top, queryType: 'simple', searchMode: 'any' });
        }
        if (!r.ok) {
          return { data: { index, matches: [], count: 0, mode: 'error', error: `search ${r.status}` }, summary: `Search failed (${r.status}).` };
        }
        const j = (await r.json()) as { value?: Array<Record<string, unknown>> };
        const matches = (j.value || []).map((d) => ({
          score: typeof d['@search.rerankerScore'] === 'number' ? d['@search.rerankerScore'] : d['@search.score'],
          text: pickText(d).slice(0, 1200),
          id: d['id'] ?? d['chunk_id'] ?? d['key'] ?? '',
        }));
        const mode = vector ? 'hybrid+semantic' : 'keyword';
        return {
          data: { index, matches, count: matches.length, mode },
          summary: `${matches.length} ${mode} match(es) in "${index}" for "${input.query}".`,
        };
      },
    },
    callerHash,
  );
}

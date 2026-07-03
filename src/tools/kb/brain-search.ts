/**
 * brain_search — read-only hybrid/semantic search over the CONSOLIDATED One Brain
 * (index `otchealth-brain` on the otchealth-brain-search service). Self-contained: reads
 * BRAIN_SEARCH_ENDPOINT + BRAIN_SEARCH_KEY directly from env (does not touch the dataroom search
 * config). Semantic-ranker only (no vector) to avoid any embedding-dimension coupling. Additive +
 * read-only; changes nothing about existing tools or ring-gating.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fetchWithBudget } from '../../util/fetch-budget.js';

const API_VERSION = '2023-11-01';

export function registerBrainSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'brain_search',
      category: 'read',
      annotations: {
        title: 'Search the consolidated OTCHealth One Brain (read-only)',
        description:
          'Hybrid semantic search over the consolidated company brain (index otchealth-brain, ~67k docs across finance/legal/ops/exec/product/cs). Read-only. Ground answers here and cite. Optional domain filter.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        query: z.string().min(1).describe('Natural-language query.'),
        top: z.number().int().min(1).max(25).optional().describe('Max results (default 8).'),
        domain: z.string().optional().describe('Optional domain filter: legal|finance|ops|exec|commons|cs'),
      },
      outputShape: {
        matches: z.array(z.unknown()),
        count: z.number(),
        mode: z.string(),
        error: z.string().optional(),
      },
      handler: async (input) => {
        const ep = (process.env.BRAIN_SEARCH_ENDPOINT || '').replace(/\/+$/, '');
        const key = process.env.BRAIN_SEARCH_KEY || '';
        const top = input.top ?? 8;
        if (!ep || !key) {
          return { data: { matches: [], count: 0, mode: 'unconfigured' }, summary: 'Brain search not configured.' };
        }
        const body: Record<string, unknown> = {
          search: input.query,
          top,
          queryType: 'semantic',
          semanticConfiguration: 'brain-semantic',
          searchMode: 'any',
          select: 'content,title,domain,source_index',
        };
        if (input.domain) body.filter = `domain eq '${String(input.domain).replace(/'/g, "''")}'`;
        const doSearch = async (b: Record<string, unknown>) =>
          fetchWithBudget(`${ep}/indexes/otchealth-brain/docs/search?api-version=${API_VERSION}`, {
            method: 'POST',
            headers: { 'api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify(b),
          });
        let r = await doSearch(body);
        if (r.status === 400) r = await doSearch({ search: input.query, top, queryType: 'simple', searchMode: 'any' });
        if (!r.ok) {
          return { data: { matches: [], count: 0, mode: 'error', error: `search ${r.status}` }, summary: `Brain search failed: ${r.status}.` };
        }
        const j = (await r.json()) as { value?: Array<Record<string, unknown>> };
        const matches = (j.value || []).map((d) => ({
          score: (typeof d['@search.rerankerScore'] === 'number' ? d['@search.rerankerScore'] : d['@search.score']) as number | undefined,
          title: (d['title'] as string) ?? '',
          domain: (d['domain'] as string) ?? '',
          source: (d['source_index'] as string) ?? '',
          text: String(d['content'] ?? '').slice(0, 1200),
        }));
        return { data: { matches, count: matches.length, mode: 'brain-semantic' }, summary: `${matches.length} match(es) in the One Brain for "${input.query}".` };
      },
    },
    callerHash,
  );
}

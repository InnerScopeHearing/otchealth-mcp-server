import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, normalizeAgent, readSharedAll } from '../../memory/store.js';
import { semanticConfigured, semanticSearch } from '../../memory/semantic.js';

export function registerMemoryRecall(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_recall',
      category: 'read',
      annotations: {
        title: 'Recall from the shared brain',
        description:
          'Search the cross-agent shared memory (kb-memory commons feed) for entries matching a query. Returns matching facts, decisions, corrections, pitfalls, and status across every agent, newest first. Use BEFORE asserting any cross-team fact: the ledger is the source of truth.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        query: z.string().min(1).describe('Keywords to match against entry text, tags, type, and agent (case-insensitive; all terms must match).'),
        agent: z.string().optional().describe('Optional: restrict to one agent lane (e.g. "cto").'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25).'),
      },
      outputShape: {
        matches: z.array(z.unknown()),
        count: z.number(),
        mode: z.string(),
      },
      handler: async (input) => {
        const limit = input.limit ?? 25;
        const agentFilter = input.agent ? normalizeAgent(input.agent) : null;

        // Prefer SEMANTIC recall (Azure AI Search memory-exec): matches by meaning, not just
        // keyword, and is the same index the fleet's per-prompt memory uses. Falls back to
        // keyword over the blob feed when search isn't configured or errors.
        if (semanticConfigured()) {
          try {
            const hits = await semanticSearch(input.query, agentFilter, limit);
            if (hits) {
              return {
                data: { matches: hits, count: hits.length, mode: 'semantic' },
                summary: `${hits.length} semantic match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''}.`,
              };
            }
          } catch {
            /* fall through to keyword */
          }
        }

        if (!isConfigured()) {
          return { data: { matches: [], count: 0, mode: 'none' }, summary: 'Shared brain not configured; no results.' };
        }
        const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
        const all = await readSharedAll();
        const matches = all
          .filter((r) => !agentFilter || r.agent === agentFilter)
          .filter((r) => {
            const hay = `${r.type} ${r.text} ${(r.tags || []).join(' ')} ${r.agent} ${r.source || ''}`.toLowerCase();
            return terms.every((t) => hay.includes(t));
          })
          .slice(0, limit);
        return {
          data: { matches, count: matches.length, mode: 'keyword' },
          summary: `${matches.length} keyword match(es) for "${input.query}"${agentFilter ? ` in ${agentFilter}` : ''}.`,
        };
      },
    },
    callerHash,
  );
}

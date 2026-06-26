/**
 * kb_search — hybrid retrieval over the fleet's OPEN Azure AI Search indexes.
 *   - 'commons-company-journal'  -> all agents (commons; non-PHI/MNPI/privileged)
 *   - 'memory-exec'              -> all agents (the shared exec brain)
 * Finance/legal indexes are RING-GATED and live in kb_search_privileged (trusted lanes only).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { hybridSearch, searchConfigured } from '../../azure/search.js';

const OPEN_INDEXES = new Set(['commons-company-journal', 'memory-exec']);
const RING_GATED_PREFIXES = ['finance-', 'legal-'];

export function registerKbSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'kb_search',
      category: 'read',
      annotations: {
        title: 'Search an open fleet knowledge index (hybrid)',
        description:
          'Hybrid (keyword + vector + semantic-ranker) search over an OPEN fleet index: "commons-company-journal" or "memory-exec". Finance/legal are ring-gated — use kb_search_privileged with a trusted role. Ground answers in the company knowledge base before asserting facts.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        index: z.string().describe('Open index: "commons-company-journal" or "memory-exec".'),
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
            data: { index, matches: [], count: 0, mode: 'ring-gated', error: 'use_kb_search_privileged' },
            summary: `"${index}" is ring-gated (finance/attorney-privileged). Use kb_search_privileged with a trusted role (cfo/clo/clo-personal).`,
          };
        }
        if (!OPEN_INDEXES.has(index)) {
          return {
            data: { index, matches: [], count: 0, mode: 'unknown-index', error: 'unknown_index' },
            summary: `Unknown/closed index "${index}". Open: ${[...OPEN_INDEXES].join(', ')}.`,
          };
        }
        if (!searchConfigured()) {
          return { data: { index, matches: [], count: 0, mode: 'unconfigured' }, summary: 'AI Search not configured.' };
        }
        try {
          const res = await hybridSearch(index, input.query, top);
          if (!res) return { data: { index, matches: [], count: 0, mode: 'unconfigured' }, summary: 'AI Search not configured.' };
          return {
            data: { index, matches: res.matches, count: res.matches.length, mode: res.mode },
            summary: `${res.matches.length} ${res.mode} match(es) in "${index}" for "${input.query}".`,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { data: { index, matches: [], count: 0, mode: 'error', error: msg }, summary: `Search failed: ${msg}.` };
        }
      },
    },
    callerHash,
  );
}

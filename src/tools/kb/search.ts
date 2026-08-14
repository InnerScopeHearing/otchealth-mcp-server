/**
 * kb_search — hybrid retrieval over the fleet's OPEN Azure AI Search indexes.
 *   - 'commons-company-journal'  -> all agents (commons; non-PHI/MNPI/privileged)
 *   - 'memory-exec'              -> all agents (the shared exec brain)
 * Finance/legal indexes are RING-GATED and live in kb_search_privileged (trusted lanes only).
 *
 * ROOM HYGIENE (demote, not delete): operational exhaust (status/episode/heartbeat/digest-style
 * ledger chatter, see memory/room-hygiene.ts) is deprioritized in memory-exec by default, ranked
 * after genuine results rather than removed, so it can still surface when nothing else scores as
 * well. Pass include_ops:true to see it at full relevance rank.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { hybridSearch, searchConfigured } from '../../search/index.js';
import { tagWithFeedbackRefs } from '../../memory/retrieval-feedback.js';

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
          'Hybrid (keyword + vector + semantic-ranker) search over an OPEN fleet index: "commons-company-journal" or "memory-exec". Finance/legal are ring-gated, use kb_search_privileged with a trusted role. Operational exhaust (status/episode/heartbeat/digest-style chatter) is deprioritized by default, not removed: it ranks after genuine results and only fills a slot when nothing better is available. Pass include_ops=true to see it at full relevance rank. Ground answers in the company knowledge base before asserting facts. Each returned match carries a `feedback_ref` token; optionally report back with the retrieval_feedback tool (useful/not_useful/cited) once you know whether a hit actually helped, no content re-send needed.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        index: z.string().describe('Open index: "commons-company-journal" or "memory-exec".'),
        query: z.string().min(1).describe('Natural-language search query.'),
        top: z.number().int().min(1).max(25).optional().describe('Max results (default 6).'),
        include_ops: z
          .boolean()
          .optional()
          .describe(
            'Include operational exhaust (status/episode/heartbeat/digest-style ledger chatter) that is EXCLUDED by default. Default false.',
          ),
      },
      outputShape: {
        index: z.string(),
        matches: z.array(z.unknown()),
        count: z.number(),
        mode: z.string(),
        include_ops: z.boolean(),
        error: z.string().optional(),
      },
      handler: async (input) => {
        const index = input.index.trim();
        const top = input.top ?? 6;
        const includeOps = input.include_ops ?? false;
        if (RING_GATED_PREFIXES.some((p) => index.startsWith(p))) {
          return {
            data: { index, matches: [], count: 0, mode: 'ring-gated', error: 'use_kb_search_privileged', include_ops: includeOps },
            summary: `"${index}" is ring-gated (finance/attorney-privileged). Use kb_search_privileged with a trusted role (cfo/clo/clo-personal).`,
          };
        }
        if (!OPEN_INDEXES.has(index)) {
          return {
            data: { index, matches: [], count: 0, mode: 'unknown-index', error: 'unknown_index', include_ops: includeOps },
            summary: `Unknown/closed index "${index}". Open: ${[...OPEN_INDEXES].join(', ')}.`,
          };
        }
        if (!searchConfigured()) {
          return { data: { index, matches: [], count: 0, mode: 'unconfigured', include_ops: includeOps }, summary: 'AI Search not configured.' };
        }
        try {
          const res = await hybridSearch(index, input.query, top, { includeOps });
          if (!res) return { data: { index, matches: [], count: 0, mode: 'unconfigured', include_ops: includeOps }, summary: 'AI Search not configured.' };
          // Tag each hit with a stable, short-lived feedback_ref (pure/synchronous, cannot fail or
          // add latency) so a later call can report whether it was useful without re-sending content.
          // See memory/retrieval-feedback.ts.
          const tagged = tagWithFeedbackRefs(res.matches, { tool: 'kb_search', query: input.query, defaultRoom: index });
          return {
            data: { index, matches: tagged, count: tagged.length, mode: res.mode, include_ops: includeOps },
            summary: `${res.matches.length} ${res.mode} match(es) in "${index}" for "${input.query}".` + (includeOps ? ' Operational chatter included.' : ''),
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { data: { index, matches: [], count: 0, mode: 'error', error: msg, include_ops: includeOps }, summary: `Search failed: ${msg}.` };
        }
      },
    },
    callerHash,
  );
}

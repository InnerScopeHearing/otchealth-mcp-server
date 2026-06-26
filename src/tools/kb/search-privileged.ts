/**
 * kb_search_privileged — RING-GATED hybrid retrieval over the sensitive dataroom indexes.
 *
 * HARD RING BOUNDARY (unwaivable): finance = MNPI/securities-sensitive; legal = attorney-privileged.
 * These must NEVER reach an external third-party AI client. Enforcement: the caller's OAuth-derived
 * agent lane (ctx.callerAgent) must EXACTLY match the index's allowed trusted lane. The broad
 * 'cto'/default/static-connector identity is deliberately EXCLUDED, so the externally-reachable
 * connector can never retrieve privileged data — only a dedicated trusted per-role OAuth client
 * (which Matt mints and never hands to an external platform) can.
 *
 *   finance-cfo-source-docs            -> ['cfo']
 *   finance-otchealth-cfo-source-docs  -> ['cfo']
 *   legal-company                      -> ['clo']
 *   legal-personal                     -> ['clo-personal']   (most sensitive; personal privilege)
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { hybridSearch, searchConfigured } from '../../azure/search.js';

const INDEX_LANES: Record<string, string[]> = {
  'finance-cfo-source-docs': ['cfo'],
  'finance-otchealth-cfo-source-docs': ['cfo'],
  'legal-company': ['clo'],
  'legal-personal': ['clo-personal'],
};

export function registerKbSearchPrivileged(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'kb_search_privileged',
      category: 'read',
      annotations: {
        title: 'Search a ring-gated dataroom index (trusted lane only)',
        description:
          'Hybrid search over RING-GATED dataroom indexes (finance = MNPI; legal = attorney-privileged). Enforced to the exact trusted lane: finance-* requires the cfo agent, legal-company requires clo, legal-personal requires clo-personal. The cto/default/external connector identity is refused. Privileged data never reaches an external client.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        index: z.enum([
          'finance-cfo-source-docs',
          'finance-otchealth-cfo-source-docs',
          'legal-company',
          'legal-personal',
        ]).describe('Ring-gated index. Caller must hold the matching trusted lane.'),
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
      handler: async (input, ctx) => {
        const index = input.index;
        const top = input.top ?? 6;
        const lanes = INDEX_LANES[index] ?? [];
        const caller = ctx.callerAgent || '';
        // RING ENFORCEMENT: exact trusted-lane match; cto/default/external excluded.
        if (!caller || !lanes.includes(caller)) {
          return {
            data: { index, matches: [], count: 0, mode: 'ring-forbidden', error: 'forbidden_ring' },
            summary: `Refused: "${index}" requires the ${lanes.join('/')} trusted lane. Your identity: ${caller || '(none)'}. Privileged/MNPI data is never served to other lanes or external clients.`,
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
            summary: `${res.matches.length} ${res.mode} match(es) in privileged "${index}" for "${input.query}" (lane=${caller}).`,
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

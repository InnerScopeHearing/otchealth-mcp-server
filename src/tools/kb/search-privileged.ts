/**
 * kb_search_privileged — RING-GATED hybrid retrieval over the sensitive dataroom indexes.
 *
 * HARD RING BOUNDARY (unwaivable): finance = MNPI/securities-sensitive; legal = attorney-privileged.
 * These must NEVER reach an external third-party AI client. Enforcement: the caller's OAuth-derived
 * agent lane (ctx.callerAgent) must EXACTLY match one of the index's allowed trusted lanes. The broad
 * 'cto'/default/static-connector identity is deliberately EXCLUDED, so the externally-reachable
 * connector can never retrieve privileged data — only a dedicated trusted per-role OAuth client
 * (which Matt mints and never hands to an external platform) can.
 *
 * SCOPED MUTUAL CROSS-READ (CEO direction): the clo/clo-personal and cfo trusted lanes may read
 * each other's privileged indexes. This is intentionally limited to those three identities —
 * no other agent (coo/cro/cpo/cco/developer/app-leads/cto/etc.) is added to any array below.
 *
 *   finance-cfo-source-docs            -> ['cfo', 'clo', 'clo-personal']
 *   finance-otchealth-cfo-source-docs  -> ['cfo', 'clo', 'clo-personal']
 *   finance-cfo-memory                 -> ['cfo', 'clo', 'clo-personal']
 *   legal-company                      -> ['clo', 'cfo']
 *   legal-personal                     -> ['clo-personal', 'clo', 'cfo']   (most sensitive; personal privilege)
 *   legal-personal-memory              -> ['clo-personal', 'clo', 'cfo']
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { hybridSearch, searchConfigured } from '../../azure/search.js';

export const INDEX_LANES: Record<string, string[]> = {
  'finance-cfo-source-docs': ['cfo', 'clo', 'clo-personal'],
  'finance-otchealth-cfo-source-docs': ['cfo', 'clo', 'clo-personal'],
  'finance-cfo-memory': ['cfo', 'clo', 'clo-personal'],
  'legal-company': ['clo', 'cfo'],
  'legal-personal': ['clo-personal', 'clo', 'cfo'],
  'legal-personal-memory': ['clo-personal', 'clo', 'cfo'],
};

/** Pure ring-enforcement predicate, exported for unit testing without spinning up the MCP server. */
export function isLaneAllowed(index: string, caller: string | undefined | null): boolean {
  const lanes = INDEX_LANES[index] ?? [];
  return Boolean(caller) && lanes.includes(caller as string);
}

export function registerKbSearchPrivileged(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'kb_search_privileged',
      category: 'read',
      annotations: {
        title: 'Search a ring-gated dataroom index (trusted lane only)',
        description:
          'Hybrid search over RING-GATED dataroom indexes (finance = MNPI; legal = attorney-privileged). Enforced to the trusted lanes on record for each index: finance-*/finance-cfo-memory allow cfo, clo, clo-personal; legal-company/legal-personal/legal-personal-memory allow clo, clo-personal, cfo (scoped clo<->cfo mutual read). The cto/default/external connector identity is refused, as is every other agent identity. Privileged data never reaches an external client.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        index: z.enum([
          'finance-cfo-source-docs',
          'finance-otchealth-cfo-source-docs',
          'finance-cfo-memory',
          'legal-company',
          'legal-personal',
          'legal-personal-memory',
        ]).describe('Ring-gated index. Caller must hold one of the matching trusted lanes.'),
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
        // RING ENFORCEMENT: caller must be one of the index's trusted lanes; cto/default/external excluded.
        if (!isLaneAllowed(index, caller)) {
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

/**
 * kb_search_privileged — RING-GATED hybrid retrieval over the sensitive dataroom indexes.
 *
 * HARD RING BOUNDARY (unwaivable): finance = MNPI/securities-sensitive; legal = attorney-privileged.
 * These must NEVER reach an external third-party AI client. Enforcement: the caller's OAuth-derived
 * agent lane (ctx.callerAgent) must EXACTLY match one of the index's allowed trusted lanes. An unknown
 * or external caller resolves to '' and is refused.
 *
 * The broad 'cto'/default/static-connector identity is deliberately EXCLUDED from every privileged
 * index. The cto identity is the widely-connected, externally-reachable connector for the agent-OS;
 * keeping it out of MNPI + attorney-privileged data caps the blast radius of the most sensitive corpora
 * and costs nothing operationally (cto retains full non-privileged recall via the open memory-exec brain).
 * Only a dedicated trusted per-role OAuth client (which Matt mints and never hands to an external
 * platform) can retrieve privileged data.
 *
 * EXECUTIVE-RING CROSS-READ (CEO direction, 2026-07-02): the executive team shares privileged FINANCE and
 * COMPANY-LEGAL context so institutional knowledge compounds and requires less manual curation. Those
 * indexes are readable by the full exec ring:
 *   EXEC_RING = ['cfo','clo','clo-personal','cpo','cco','exec']  ('exec' = unified chief, 2026-07-04)
 * NON-exec identities are NEVER added to any array below: 'developer' (engineering IC), every app-lead/
 * product agent (iheartest, innerease, flatstick, fourvault, fictionary, companion, otchealthmart, etc.),
 * 'focus-group', AND the broad 'cto'/default connector identity.
 *
 * PERSONAL-LEGAL CARVE-OUT (Matt direction, 2026-07-16 — NARROWER than the exec ring): legal-personal and
 * legal-personal-memory carry the most sensitive attorney-privileged content (CA divorce/family/civil,
 * incl. minors' data). They are gated to PERSONAL_LEGAL_RING = ['clo-personal','exec'] ONLY — the dedicated
 * personal-legal lane plus the unified One-Brain chief. The individual chiefs (cfo/cpo/cco) AND the
 * company-legal 'clo' lane are STRIPPED. This closes a confirmed cross-ring leak (a cfo-lane brain_search
 * returned personal-legal rooms). It supersedes the 2026-07-02 blanket "all privileged -> exec ring" line
 * for these two rooms ONLY; finance + company-legal keep the full exec cross-read.
 *
 *   finance-cfo-source-docs            -> EXEC_RING
 *   finance-otchealth-cfo-source-docs  -> EXEC_RING
 *   finance-cfo-memory                 -> EXEC_RING
 *   legal-company                      -> EXEC_RING
 *   legal-personal                     -> PERSONAL_LEGAL_RING   (most sensitive; clo-personal + exec only)
 *   legal-personal-memory              -> PERSONAL_LEGAL_RING
 *
 * COO/CRO REMOVED FROM THE EXEC RING (Matt direction, 2026-07-21, least-privilege): newly-provisioned coo
 * and cro gateway lanes are no longer members of EXEC_RING. They now resolve to OPEN_ROOMS only (memory-exec,
 * commons-company-journal) on every surface derived from EXEC_RING, including this tool, brain_search,
 * legal_blob_*, and xero_*. This honors the CRO securities firewall (the revenue lane never reaches finance
 * MNPI or company-legal) and tightens the privileged rooms to cfo, clo, clo-personal, cpo, cco, exec. cpo
 * and cco are unchanged.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { hybridSearch, searchConfigured } from '../../azure/search.js';

/** The executive ring: the only identities permitted on privileged indexes. Defined once, applied to all.
 * 'exec' = the UNIFIED executive identity (CEO direction 2026-07-04): the solo operator wears every C-suite
 * hat, so the individual chief lanes collapse into one 'exec' lane carrying the full exec cross-read. The
 * per-chief lanes remain valid (unchanged) for anyone still using them. NON-exec identities are STILL never
 * added below — 'cto' (the externally-reachable connector) + 'developer' + app-leads stay off MNPI/privileged. */
export const EXEC_RING = ['cfo', 'clo', 'clo-personal', 'cpo', 'cco', 'exec'] as const;

/** The PERSONAL-LEGAL ring: strictly NARROWER than EXEC_RING. Gates the two most sensitive rooms
 * (legal-personal, legal-personal-memory — attorney-privileged CA divorce/family/civil, incl. minors'
 * data) to the dedicated personal-legal lane plus the unified One-Brain chief ONLY. Both members are
 * already in EXEC_RING, so this is a pure TIGHTENING (it removes cfo/cpo/cco and company-legal
 * 'clo'), never a widening. Ring-width decision: Matt, 2026-07-16 (Option B), closing a confirmed
 * cross-ring leak where a cfo-lane brain_search returned legal-personal content. */
export const PERSONAL_LEGAL_RING = ['clo-personal', 'exec'] as const;

export const INDEX_LANES: Record<string, string[]> = {
  'finance-cfo-source-docs': [...EXEC_RING],
  'finance-otchealth-cfo-source-docs': [...EXEC_RING],
  'finance-cfo-memory': [...EXEC_RING],
  'legal-company': [...EXEC_RING],
  'legal-personal': [...PERSONAL_LEGAL_RING],
  'legal-personal-memory': [...PERSONAL_LEGAL_RING],
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
        title: 'Search a ring-gated dataroom index (executive ring only)',
        description:
          'Hybrid search over RING-GATED dataroom indexes (finance = MNPI; legal = attorney-privileged). Enforced to the executive ring on record for each index: cfo, clo, clo-personal, cpo, cco, exec. The cto/default/external connector identity is refused, as is developer, coo, cro, every app-lead/product agent, and every other identity. Privileged data never reaches an external client.',
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
        // RING ENFORCEMENT: caller must be one of the index's exec-ring lanes; cto/default/external excluded.
        if (!isLaneAllowed(index, caller)) {
          return {
            data: { index, matches: [], count: 0, mode: 'ring-forbidden', error: 'forbidden_ring' },
            summary: `Refused: "${index}" requires one of the ${lanes.join('/')} trusted lanes. Your identity: ${caller || '(none)'}. Privileged/MNPI data is never served to other lanes or external clients.`,
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

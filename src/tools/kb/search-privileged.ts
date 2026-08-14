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
 *
 * THE THREE-TIER PRIVILEGE MODEL (Wave 3 item 3.2, 2026-07-21): the COO/CRO removal above established
 * that EXEC_RING was conflating two genuinely different kinds of elevated access: (a) true finance-MNPI
 * plus attorney-privileged legal room access (cfo, clo, clo-personal, exec, each with a clear reason to
 * be there), and (b) whatever cpo/cco actually need, which is NOT yet determined (they are today full
 * EXEC_RING members but dormant, no live client). Every gateway lane now falls into exactly one of three
 * tiers:
 *
 *   1. non-privileged  the default floor. external-read, every app-lead/product agent (iheartest,
 *      innerease, flatstick, fourvault, fictionary, companion, otchealthmart, etc.), focus-group, and
 *      the broad cto/developer engineering identities. No finance/legal/ops elevation.
 *   2. OPS_RING         elevated, but explicitly NOT finance-MNPI or attorney-privileged legal. For a
 *      lane that needs SOME step-up beyond the non-privileged floor without touching the two genuinely
 *      sensitive corpora below. See isOpsRingLane().
 *   3. EXEC_RING        true finance-MNPI and attorney-privileged legal room access, unchanged by this
 *      paragraph.
 *
 * OPS_RING starts EMPTY below. No lane is confirmed to belong here yet; deciding which lane(s), if any,
 * populate it is Wave 3 item 3.1's job (a separate, still-open item: build the ring-parity canary, then
 * get Matt's one-sentence keep-or-cut on cpo/cco), not this one. Item 3.2 (this change) is PURELY the
 * additive architectural split: it introduces the ring plus its predicates so 3.1 has somewhere real to
 * land its answer, but it moves NOBODY. In particular, cpo and cco stay exactly where they are today,
 * full EXEC_RING members, until 3.1 resolves whether they keep that access, move to OPS_RING, or are cut
 * entirely. Populating OPS_RING, or narrowing EXEC_RING to remove cpo/cco, is a SEPARATE follow-on diff
 * to this file, reviewed on its own.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
// Routed through the SEARCH_BACKEND dispatcher, NOT azure/search.js directly, so privileged rooms
// keep working when Azure is retired. This is ring-NEUTRAL by construction: the ring decision
// (isLaneAllowed, from INDEX_LANES / PERSONAL_LEGAL_RING below) is made entirely BEFORE the search
// call and depends only on (index, callerAgent). hybridSearch() therefore only ever receives an
// index name that has ALREADY been authorized for this caller, so which engine serves that name
// cannot widen a ring. INDEX_LANES, PERSONAL_LEGAL_RING, isLaneAllowed, and the order of the ring
// check relative to the search call are all unchanged.
import { hybridSearch, searchConfigured } from '../../search/index.js';

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

/** The OPS ring: elevated access that is explicitly NOT finance-MNPI or attorney-privileged legal (see
 * the file header's three-tier model). Sibling to EXEC_RING and PERSONAL_LEGAL_RING, not a subset or
 * superset of either -- a lane here gets whatever future ops-scoped surfaces are built for it, never
 * the privileged finance/legal rooms below (INDEX_LANES has no OPS_RING entry and must not gain one;
 * an ops-tier need for a specific privileged room is itself a widening decision, made explicitly on
 * EXEC_RING or PERSONAL_LEGAL_RING, never smuggled in through this ring).
 *
 * Starts EMPTY. Populating it (item 3.1) is a separate, evidence-gathering-then-Matt-decision follow-on;
 * this change only builds the ring so that decision has somewhere real to land. Typed as `readonly
 * string[]` (not `as const`) since, unlike EXEC_RING/PERSONAL_LEGAL_RING, its membership is expected to
 * change on a future diff and there is no fixed literal tuple to pin yet. */
export const OPS_RING: readonly string[] = [];

/** Pure predicate: is `lane` a full EXEC_RING member (true finance-MNPI / attorney-privileged legal
 * access)? Exported as the canonical form of the check every call site (oauth.ts's
 * isPrivilegedDefaultAgent, registry.ts's isShipLane, xero/client.ts's isXeroAllowed) already inlines
 * against EXEC_RING directly; those existing call sites are unaffected and untouched by this change,
 * this is offered for any FUTURE call site that wants the check without re-deriving it. */
export function isExecRingLane(lane: string | undefined | null): boolean {
  return Boolean(lane) && (EXEC_RING as readonly string[]).includes(lane as string);
}

/** Pure predicate: is `lane` an OPS_RING member? Mirrors isExecRingLane() above and isLaneAllowed()
 * below. Always false today (OPS_RING is empty) until item 3.1 populates the ring; exported now so
 * that future population is a one-line data change, never a new predicate. */
export function isOpsRingLane(lane: string | undefined | null): boolean {
  return Boolean(lane) && OPS_RING.includes(lane as string);
}

export type PrivilegeTier = 'exec' | 'ops' | 'none';

/** Classifies `lane` into exactly one of the three privilege tiers described in the file header. Exec
 * wins if a lane were ever (mistakenly) present in both rings, so an accidental overlap fails safe
 * toward the MORE scrutinized tier, never the less. Pure; exported for any future call site (e.g. a
 * prospective ops-scoped connector toolset) that wants the three-tier read directly instead of
 * re-deriving it from two separate boolean checks. */
export function privilegeTierOf(lane: string | undefined | null): PrivilegeTier {
  if (isExecRingLane(lane)) return 'exec';
  if (isOpsRingLane(lane)) return 'ops';
  return 'none';
}

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

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, normalizeAgent, readSharedAll } from '../../memory/store.js';
import { computeRetractedIds, boundRecord } from './wake.js';
import { retractedIdsForAgent } from '../../memory/retractions.js';

/**
 * memory_pack — one-call working-set loader for ANY client/platform. Given an agent lane, returns
 * the durable context that agent should boot with: its latest status, its corrections (current
 * truths that override older belief), recent decisions, and recent facts/pitfalls. This is the
 * cross-platform replacement for Claude Code's per-prompt memory injection (which Hyperagent /
 * ChatGPT / Perplexity etc. do not have): a new or existing agent calls memory_pack on wake and
 * is immediately current. Ring-safe: reads only the shared exec feed.
 */

// ---- BRIEF PACK (P2-3, 2026-07-29; corrected 2026-07-30 per review) ----------------------------
// Same real bug report as wake's BRIEF WAKE (see src/tools/memory/wake.ts's header comment for the
// full context): a long-lived agent session's memory_pack was measured at ~99KB and JIT-offloading
// (result-store.ts THRESHOLD_CHARS=40000). Unlike wake, memory_pack had NO text capping and NO
// superseded-collapsing at all in its full-mode response -- status/corrections/decisions/recent
// were all returned verbatim, uncapped, which is the larger share of that 99KB.
//
// FIX (brief: true, default false -- ADDITIVE; brief:false is byte-for-byte today's existing,
// uncapped behavior, nothing below changes it):
//   - retraction is computed ONCE, GLOBALLY, across the complete per-agent feed (every type, not
//     just corrections) via wake.ts's computeRetractedIds -- reusing the SAME fix wake.ts needed
//     for the same reason (a per-list collapse alone misses a cross-type retraction, e.g. a
//     decision superseding a correction, or a fact superseding a decision).
//   - every kept record is bounded with wake.ts's boundRecord (the generic recursive value-shape
//     bound), not capText -- capText only ever touches a `text` field, and a review finding showed
//     memory_pack corrections/decisions can carry unbounded `source`/`tags` fields capText would
//     leave untouched. Reusing the already-proven fix (four field-specific capText patches on
//     wake's own M365-lite path before it was rewritten this way) rather than re-inventing it here.
//   - `recent` is a small, retraction-filtered subset of the non-correction/non-decision entries
//     (facts, pitfalls, ...), not dropped to `[]` -- dropping it entirely used to lose every current
//     fact/pitfall, since corrections/decisions above are type-filtered and never carry those types.
// `id` is never touched, so any brief entry can be resolved to its full record via
// memory_pack(brief:false) (memory_search does NOT resolve these -- see the tool description).
// PACK_BRIEF_TEXT_CAP was 300 in the first pass but never actually threaded into boundRecord (it
// silently truncated at wake.ts's M365-lite default cap of 100 chars instead -- a dead, misleading
// constant; review finding, 2026-07-30, same class of bug as WAKE_BRIEF_TEXT_CAP). Now genuinely
// threaded through (see boundNonNull below); kept at the value already proven safe under the 40000-
// char offload budget rather than restoring 300, which would roughly triple per-field cost and risk
// blowing the budget the same way WAKE_BRIEF_TEXT_CAP's restoration would have (see wake.ts's own
// WAKE_BRIEF_TEXT_CAP comment for the measured numbers).
export const PACK_BRIEF_TEXT_CAP = 100;
export const PACK_BRIEF_LIST_CAP = 8;
export const PACK_BRIEF_RECENT_FACT_CAP = 5;

export interface PackFullData {
  agent: string;
  status: Record<string, unknown> | null;
  corrections: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  recent: Record<string, unknown>[];
  count: number;
}

/** boundRecord never returns null for a non-null input; this just narrows the type back for
 * callers mapping over lists that are already known non-null. Pure. Threads PACK_BRIEF_TEXT_CAP
 * through explicitly (see that constant's own comment for why the default cap alone is wrong). */
function boundNonNull(rec: Record<string, unknown>): Record<string, unknown> {
  return boundRecord(rec, PACK_BRIEF_TEXT_CAP) as Record<string, unknown>;
}

/**
 * Build the brief-mode replacement for `recent`: instead of dropping it to `[]` (which loses every
 * unsuperseded 'fact'/'pitfall' entry entirely, since corrections/decisions above are type-filtered
 * and never carry those types), keep a small, retraction-filtered, capped subset of the
 * non-correction/non-decision/non-status types (status is excluded too -- review finding,
 * 2026-07-30: `rawMine` is the complete feed and DOES contain the status row, which would otherwise
 * duplicate the separately-returned `status` field and consume one of the few recent slots).
 * `rawMine` is the COMPLETE unsliced per-agent shared feed (not the already-capped `full.recent`),
 * mirroring wake.ts's buildBriefRecentFacts. `recentCap` lets the caller respect its own
 * recent_limit input (review finding, 2026-07-30) -- min()'d against PACK_BRIEF_RECENT_FACT_CAP by
 * the caller before this function sees it. Pure.
 */
function buildBriefRecentFacts(rawMine: Record<string, unknown>[], retractedIds: Set<string>, recentCap: number): Record<string, unknown>[] {
  return rawMine
    .filter((r) => {
      const type = r['type'];
      const id = r['id'];
      if (type === 'correction' || type === 'decision' || type === 'status') return false; // already covered above
      if (typeof id === 'string' && retractedIds.has(id)) return false;
      return true;
    })
    .slice(0, recentCap)
    .map(boundNonNull);
}

/**
 * Condense a full memory_pack response into a brief, current-truth-only, small working set. Pure +
 * testable. Field names/shape are kept identical to the full response so this cannot violate the
 * tool's declared outputShape -- only the CONTENT inside each field shrinks.
 *
 * `rawMine` is the COMPLETE, unsliced per-agent shared feed (every type, not capped by
 * recent_limit) -- passed separately from `full`, mirroring wake.ts's buildBriefWake. It lets
 * retraction and the brief recent-facts list see entries beyond whatever the already-capped
 * corrections/decisions/recent slices happened to include. Optional + defaults to the union of the
 * already-capped slices for callers (tests) that don't have the raw feed handy -- correctness
 * degrades gracefully, it never throws.
 *
 * `externalRetractedIds`, if supplied, is UNIONED WITH (never substituted for) the locally-derived
 * computeRetractedIds set -- review finding, 2026-07-30: the real handler's retractedIdsForAgent()
 * call fails open and is TTL-cached, so it can legitimately omit a `supersedes` that `mine` itself
 * already proves exists (a just-written correction inside the cache window, or a transient store
 * error). Replacing the local set with the external one would then un-retract something this very
 * payload shows is stale. memory_pack has only the shared feed (no separate Cosmos source of its
 * own), but a Cosmos memory_record can still supersede a shared-feed entry (memory/retractions.ts
 * collects from BOTH stores) -- something `computeRetractedIds(mine)` alone, seeing only this
 * tool's own feed, could never detect; the union is a pure ADDITION for that case, never a
 * subtraction. Omitted (the default) in tests, which then rely solely on computeRetractedIds over
 * exactly the synthetic fixture.
 *
 * `recentLimit`, if supplied, is min()'d against PACK_BRIEF_RECENT_FACT_CAP so a caller's own
 * recent_limit input is honored even in brief mode; omitted defaults to the cap.
 */
export function buildBriefPack(
  full: PackFullData,
  rawMine?: Record<string, unknown>[],
  externalRetractedIds?: Set<string>,
  recentLimit?: number,
): Record<string, unknown> {
  const mine = rawMine ?? [...full.corrections, ...full.decisions, ...full.recent];

  // ONE global retracted-id set: the locally-derived one (every type available in `mine` -- see
  // wake.ts's computeRetractedIds header for why a per-list collapse alone misses a cross-type
  // retraction) UNIONED with the externally-supplied one, if any (see this function's own header
  // for why union, not replace).
  const retractedIds = computeRetractedIds(mine);
  if (externalRetractedIds) for (const id of externalRetractedIds) retractedIds.add(id);

  const notRetracted = (r: Record<string, unknown>) => {
    const id = r['id'];
    return !(typeof id === 'string' && retractedIds.has(id));
  };

  // corrections/decisions are sourced from `mine` (type-filtered), NOT from full.corrections/
  // decisions -- review finding, 2026-07-30: full.corrections/decisions are ALREADY capped to 15 by
  // the handler's own full-mode construction (unrelated to brief mode), so filtering-then-slicing
  // THAT pre-capped list means a retracted entry among the top 15 shrinks the brief result below
  // PACK_BRIEF_LIST_CAP even when a 16th, live, correction exists in `mine`. Sourcing from `mine`
  // (the complete feed when the handler supplies rawMine; degrades to the same pre-capped union
  // when it doesn't, e.g. in a test with no rawMine) lets a live entry backfill the slot a
  // retracted one vacated.
  const corrections = mine
    .filter((r) => r['type'] === 'correction')
    .filter(notRetracted)
    .slice(0, PACK_BRIEF_LIST_CAP)
    .map(boundNonNull);
  const decisions = mine
    .filter((r) => r['type'] === 'decision')
    .filter(notRetracted)
    .slice(0, PACK_BRIEF_LIST_CAP)
    .map(boundNonNull);
  const recentCap = Math.min(PACK_BRIEF_RECENT_FACT_CAP, recentLimit ?? PACK_BRIEF_RECENT_FACT_CAP);
  const recent = buildBriefRecentFacts(mine, retractedIds, recentCap);

  // status can itself be retracted (memory_remember allows `supersedes` on every entry type,
  // including a later fact/correction retracting the latest status row) -- review finding,
  // 2026-07-30: this previously bypassed notRetracted entirely.
  const statusId = full.status?.['id'];
  const statusRetracted = typeof statusId === 'string' && retractedIds.has(statusId);
  const status = full.status && !statusRetracted ? boundNonNull(full.status) : null;

  return {
    agent: full.agent,
    status,
    corrections,
    decisions,
    recent, // a bounded, retraction-filtered fact/pitfall subset -- NOT emptied (see
    // buildBriefRecentFacts: dropping this entirely used to lose every current fact/pitfall, since
    // corrections/decisions above are type-filtered and never carry those types).
    count: full.count,
  };
}

export function registerMemoryPack(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_pack',
      category: 'read',
      annotations: {
        title: 'Load an agent working set',
        description:
          'Boot context for an agent in one call: latest status + corrections (current truths) + recent decisions + recent facts/pitfalls from the shared brain. Call this on wake on ANY platform so the agent is immediately up to date. Pass brief:true on a long-lived session (large ledger) to get only current-truth entries (retracted/superseded entries filtered out across every section, not just within one), hard-capped for size, so the response stays inline instead of JIT-offloading. DRILL-DOWN CAVEAT: memory_search resolves a Cosmos memory_record by id -- it does NOT resolve a truncated status/correction/decision/recent entry returned by this tool, since those are shared blob-feed MemoryEntry rows, a different store. For a truncated entry here, re-call memory_pack(brief:false) to see the untruncated version. Ring-safe (shared feed only).',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        agent: z.string().optional().describe('Agent lane to load; defaults to your token identity (lowercase id, e.g. "cto", "developer").'),
        recent_limit: z.number().int().min(1).max(80).optional().describe('Max recent entries to include (default 30).'),
        brief: z
          .boolean()
          .optional()
          .describe(
            'If true, return only current-truth entries (retracted/superseded entries filtered out across every section) with ids for drill-down via memory_pack(brief:false), hard-capped for size. Defaults to false (unchanged full behavior).',
          ),
      },
      outputShape: {
        agent: z.string(),
        status: z.unknown(),
        corrections: z.array(z.unknown()),
        decisions: z.array(z.unknown()),
        recent: z.array(z.unknown()),
        count: z.number(),
      },
      handler: async (input, ctx) => {
        const agentRaw = input.agent || ctx.callerAgent;
        if (!agentRaw) {
          return { data: { agent: '', status: null, corrections: [], decisions: [], recent: [], count: 0 }, summary: 'No agent specified and no caller identity; pass agent.' };
        }
        const agent = normalizeAgent(agentRaw);
        if (!isConfigured()) {
          return {
            data: { agent, status: null, corrections: [], decisions: [], recent: [], count: 0 },
            summary: 'Shared brain not configured; empty pack.',
          };
        }
        const recentLimit = input.recent_limit ?? 30;
        const mine = (await readSharedAll()).filter((r) => r.agent === agent); // already newest-first
        const status = mine.find((r) => r.type === 'status') ?? null;
        const corrections = mine.filter((r) => r.type === 'correction').slice(0, 15);
        const decisions = mine.filter((r) => r.type === 'decision').slice(0, 15);
        const recent = mine.slice(0, recentLimit);

        const brief = input.brief ?? false;
        const fullData: PackFullData = {
          agent,
          status: status as unknown as Record<string, unknown> | null,
          corrections: corrections as unknown as Record<string, unknown>[],
          decisions: decisions as unknown as Record<string, unknown>[],
          recent: recent as unknown as Record<string, unknown>[],
          count: mine.length,
        };
        // The canonical, AGENT-SCOPED retraction set (memory/retractions.ts's retractedIdsForAgent,
        // NOT the bare fleet-wide retractedIds() -- review finding, 2026-07-30: shared-feed ids are
        // per-agent day+counter values, so two different agents' entries can share a bare id; the
        // fleet-wide set would then risk hiding an unrelated agent's live entry via a coincidental
        // collision. retractedIdsForAgent groups retractions by the SUPERSEDING entry's own agent
        // before returning, so this is safe to union directly against `agent`'s own payload). Spans
        // the complete shared feed AND a dedicated Cosmos query for every supersedes-bearing row,
        // catching a Cosmos-sourced retraction of a shared-feed entry that this tool's own single-
        // store view could never see. Fail-open internally (never throws) but still guarded
        // defensively since it is a live-store call. UNIONED (never substituted) with
        // buildBriefPack's own local set -- see that function's header for why.
        let externalRetractedIds: Set<string> | undefined;
        if (brief) {
          try {
            externalRetractedIds = await retractedIdsForAgent(agent);
          } catch {
            /* fail-open: buildBriefPack falls back to computeRetractedIds over the shared feed alone */
          }
        }
        const data = brief ? buildBriefPack(fullData, mine as unknown as Record<string, unknown>[], externalRetractedIds, recentLimit) : fullData;

        return {
          data,
          summary: `pack(${agent})${brief ? ' [brief]' : ''}: ${mine.length} entries — ${corrections.length} corrections, ${decisions.length} decisions${status ? ', status present' : ''}.`,
        };
      },
    },
    callerHash,
  );
}

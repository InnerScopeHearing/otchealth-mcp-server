import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, normalizeAgent, readSharedAll } from '../../memory/store.js';
import { computeRetractedIds, boundRecord } from './wake.js';

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
export const PACK_BRIEF_TEXT_CAP = 300;
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
 * callers mapping over lists that are already known non-null. Pure. */
function boundNonNull(rec: Record<string, unknown>): Record<string, unknown> {
  return boundRecord(rec) as Record<string, unknown>;
}

/**
 * Build the brief-mode replacement for `recent`: instead of dropping it to `[]` (which loses every
 * unsuperseded 'fact'/'pitfall' entry entirely, since corrections/decisions above are type-filtered
 * and never carry those types), keep a small, retraction-filtered, capped subset of the
 * non-correction/non-decision types. `rawMine` is the COMPLETE unsliced per-agent shared feed (not
 * the already-capped `full.recent`), mirroring wake.ts's buildBriefRecentFacts. Pure.
 */
function buildBriefRecentFacts(rawMine: Record<string, unknown>[], retractedIds: Set<string>): Record<string, unknown>[] {
  return rawMine
    .filter((r) => {
      const type = r['type'];
      const id = r['id'];
      if (type === 'correction' || type === 'decision') return false; // already covered above
      if (typeof id === 'string' && retractedIds.has(id)) return false;
      return true;
    })
    .slice(0, PACK_BRIEF_RECENT_FACT_CAP)
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
 */
export function buildBriefPack(full: PackFullData, rawMine?: Record<string, unknown>[]): Record<string, unknown> {
  const mine = rawMine ?? [...full.corrections, ...full.decisions, ...full.recent];

  // ONE global retracted-id set across every entry available, before any type-specific filtering --
  // see wake.ts's computeRetractedIds header for why a per-list collapse alone misses a cross-type
  // retraction. memory_pack has only the shared feed (no separate Cosmos source), so this is a
  // single-list call, unlike wake's two-list (shared feed + memory_records) call.
  const retractedIds = computeRetractedIds(mine);

  const notRetracted = (r: Record<string, unknown>) => {
    const id = r['id'];
    return !(typeof id === 'string' && retractedIds.has(id));
  };

  const corrections = full.corrections.filter(notRetracted).slice(0, PACK_BRIEF_LIST_CAP).map(boundNonNull);
  const decisions = full.decisions.filter(notRetracted).slice(0, PACK_BRIEF_LIST_CAP).map(boundNonNull);
  const recent = buildBriefRecentFacts(mine, retractedIds);

  return {
    agent: full.agent,
    status: full.status ? boundRecord(full.status) : null,
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
        const data = brief ? buildBriefPack(fullData, mine as unknown as Record<string, unknown>[]) : fullData;

        return {
          data,
          summary: `pack(${agent})${brief ? ' [brief]' : ''}: ${mine.length} entries — ${corrections.length} corrections, ${decisions.length} decisions${status ? ', status present' : ''}.`,
        };
      },
    },
    callerHash,
  );
}

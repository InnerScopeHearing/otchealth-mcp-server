import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, normalizeAgent, readSharedAll } from '../../memory/store.js';
import { collapseSuperseded, capText } from './wake.js';

/**
 * memory_pack — one-call working-set loader for ANY client/platform. Given an agent lane, returns
 * the durable context that agent should boot with: its latest status, its corrections (current
 * truths that override older belief), recent decisions, and recent facts/pitfalls. This is the
 * cross-platform replacement for Claude Code's per-prompt memory injection (which Hyperagent /
 * ChatGPT / Perplexity etc. do not have): a new or existing agent calls memory_pack on wake and
 * is immediately current. Ring-safe: reads only the shared exec feed.
 */

// ---- BRIEF PACK (P2-3, 2026-07-29) ------------------------------------------------------------
// Same real bug report as wake's BRIEF WAKE (see src/tools/memory/wake.ts's header comment for the
// full context): a long-lived agent session's memory_pack was measured at ~99KB and JIT-offloading
// (result-store.ts THRESHOLD_CHARS=40000). Unlike wake, memory_pack had NO text capping and NO
// superseded-collapsing at all in its full-mode response -- status/corrections/decisions/recent
// were all returned verbatim, uncapped, which is the larger share of that 99KB.
//
// FIX: an explicit `brief: true` input (default false -- ADDITIVE; brief:false is byte-for-byte
// today's existing, uncapped behavior, nothing below changes it). When true: corrections and
// decisions are collapseSuperseded()'d (reusing the SAME helper wake.ts already exports and uses
// for its own corrections list -- no new supersede-detection logic invented here), every kept
// record's text is capText()'d to PACK_BRIEF_TEXT_CAP (reusing wake.ts's capText, same helper),
// list lengths are tightened to PACK_BRIEF_LIST_CAP, and `recent` is dropped entirely (it is raw,
// mixed-type shared-feed entries that substantially duplicate what corrections/decisions/status
// already carry -- the exact "duplicated between the two [wake and memory_pack]" complaint in the
// bug report). `id` is never touched, so any brief entry can be resolved to its full record via
// memory_search (or memory_pack with brief:false / a higher recent_limit).
export const PACK_BRIEF_TEXT_CAP = 300;
export const PACK_BRIEF_LIST_CAP = 8;

export interface PackFullData {
  agent: string;
  status: Record<string, unknown> | null;
  corrections: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  recent: Record<string, unknown>[];
  count: number;
}

/** collapseSuperseded operates on `T extends { id: string }`; wrap it for the loosely-typed
 * Record<string, unknown>[] shapes memory_pack carries, without losing any fields. Pure. */
function collapseSupersededRecords(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return collapseSuperseded(entries as unknown as Array<{ id: string }>) as unknown as Record<string, unknown>[];
}

/**
 * Condense a full memory_pack response into a brief, current-truth-only, small working set. Pure +
 * testable. Field names/shape are kept identical to the full response so this cannot violate the
 * tool's declared outputShape -- only the CONTENT inside each field shrinks (or, for `recent`, is
 * dropped to an empty array).
 */
export function buildBriefPack(full: PackFullData): Record<string, unknown> {
  const corrections = collapseSupersededRecords(full.corrections)
    .slice(0, PACK_BRIEF_LIST_CAP)
    .map((c) => capText(c, PACK_BRIEF_TEXT_CAP));
  const decisions = collapseSupersededRecords(full.decisions)
    .slice(0, PACK_BRIEF_LIST_CAP)
    .map((d) => capText(d, PACK_BRIEF_TEXT_CAP));
  return {
    agent: full.agent,
    status: full.status ? capText(full.status, PACK_BRIEF_TEXT_CAP) : null,
    corrections,
    decisions,
    recent: [], // dropped for size in brief mode -- corrections/decisions/status above already
    // carry the current-truth entries from this same feed; call memory_pack(brief:false) or
    // memory_recall for the raw recent feed.
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
          'Boot context for an agent in one call: latest status + corrections (current truths) + recent decisions + recent facts/pitfalls from the shared brain. Call this on wake on ANY platform so the agent is immediately up to date. Pass brief:true on a long-lived session (large ledger) to get only current-truth entries (superseded ones collapsed), hard-capped for size, so the response stays inline instead of JIT-offloading. Ring-safe (shared feed only).',
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
            'If true, return only current-truth entries (superseded ones collapsed) with ids for drill-down, hard-capped for size. Defaults to false (unchanged full behavior).',
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
        const data = brief ? buildBriefPack(fullData) : fullData;

        return {
          data,
          summary: `pack(${agent})${brief ? ' [brief]' : ''}: ${mine.length} entries, ${corrections.length} corrections, ${decisions.length} decisions${status ? ', status present' : ''}.`,
        };
      },
    },
    callerHash,
  );
}

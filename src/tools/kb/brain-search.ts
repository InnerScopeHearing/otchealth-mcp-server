/**
 * brain_search — the One Brain, FEDERATED over the LIVE room indexes.
 *
 * ============================ WHY THIS WAS REWRITTEN (2026-07-13) ============================
 * This tool previously queried a single CONSOLIDATED index, `otchealth-brain` (67,645 docs, on a
 * separate `otchealth-brain-search` service). That index HAD NO WRITER. Not a broken writer -- no
 * writer at all: a grep of BOTH repos found the only reference to it outside this file was
 * fleet-backup, which READS it. Every real indexer writes somewhere else entirely
 * (semantic.mjs -> memory-exec; indexer.mjs push-search -> `{profile}-{container}`).
 *
 * So the One Brain was a one-time snapshot, frozen at ~2026-07-01, and it could never catch up.
 * Meanwhile every agent was instructed by this tool's own description to "Ground answers here and
 * cite." We spent ~12 days grounding answers in an index that had stopped learning. Measured
 * recall was hit@5 = 33% -- which was mostly STALENESS being mistaken for bad ranking, since the
 * SAME questions answered correctly at rank #1 against the live `memory-exec` index.
 *
 * Note the trap that hid it: the doc count stayed at exactly 67,645 the whole time. A doc count
 * proves an index HAS documents; it can never prove they are CURRENT. A frozen index doesn't drop
 * below a floor -- it stays identical, forever. Freshness must be asserted on the AGE of the
 * newest document, never on volume. (Ledger: 20260713-036.)
 *
 * ============================ THE FIX ============================
 * Federate. There is no consolidated copy to keep in sync, so it CANNOT go stale -- this deletes
 * the entire bug class rather than patching one instance of it. We fan out the query, in parallel,
 * to the live room indexes the caller is allowed to see, and fuse the results.
 *
 * Design notes:
 *  - Reuses `hybridSearch` (BM25 + vector + semantic reranker) -- the exact path kb_search uses and
 *    that is verified fresh -- instead of this tool's old bespoke semantic-only query.
 *  - Reuses `isLaneAllowed` from kb_search_privileged for ring-gating. The finance (MNPI) and legal
 *    (attorney-privileged) rings are NOT re-implemented here; federation must never become a side
 *    door around a privilege boundary, so a caller outside EXEC_RING simply never has those rooms
 *    fanned out to it.
 *  - Fuses with Reciprocal Rank Fusion (RRF, k=60). This matters: raw BM25/reranker scores are NOT
 *    comparable ACROSS indexes -- each index has its own scale -- so naively sorting by score would
 *    let one room's scoring quirks dominate. RRF ranks by POSITION, which is scale-free.
 *  - Per-room error isolation: one unreachable room degrades to a note, never a blank answer.
 *  - RETRACTION FILTERING (2026-07-14): a belief the fleet has explicitly retracted via `supersedes`
 *    is DROPPED from results. Before this, retrieval ignored `supersedes` entirely and served the
 *    retracted 20260713-015 at RANK #1, above the very correction that superseded it. See
 *    memory/retractions.ts. A ledger that cannot forget is not a memory -- it is a rumour mill.
 *  - ROOM HYGIENE (2026-07-15): operational exhaust (status/episode/heartbeat/digest-style ledger
 *    chatter — see memory/room-hygiene.ts) is EXCLUDED by default from every room that carries a
 *    `type` discriminator (memory-exec, finance-cfo-memory, legal-personal-memory). A high-volume
 *    "what I'm working on" status entry can otherwise dilute or outrank a real fact/decision in the
 *    fused results. Pass `include_ops:true` to see it (e.g. "what has the CFO been doing lately").
 *    Query-side only -- no indexing/data change. Fails open: a filter problem on a given room falls
 *    back to an unfiltered query for that room rather than breaking the room.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { hybridSearch, searchConfigured } from '../../azure/search.js';
import { isLaneAllowed } from './search-privileged.js';
import { retractedIds, filterRetracted } from '../../memory/retractions.js';

/** Rooms every agent may read (non-PHI / non-MNPI / non-privileged). */
export const OPEN_ROOMS = ['memory-exec', 'commons-company-journal'] as const;

/** Rooms behind the executive ring. Gated via isLaneAllowed — never re-implemented here. */
export const RING_ROOMS = [
  'finance-cfo-source-docs',
  'finance-otchealth-cfo-source-docs',
  'finance-cfo-memory',
  'legal-company',
  'legal-personal',
  'legal-personal-memory',
] as const;

/** domain filter -> the rooms it maps to. Unknown/absent domain = every room the caller may see. */
const DOMAIN_ROOMS: Record<string, readonly string[]> = {
  exec: ['memory-exec'],
  commons: ['commons-company-journal'],
  ops: ['commons-company-journal'],
  finance: ['finance-cfo-source-docs', 'finance-otchealth-cfo-source-docs', 'finance-cfo-memory'],
  legal: ['legal-company', 'legal-personal', 'legal-personal-memory'],
};

/** The rooms this caller is permitted to search, optionally narrowed by a domain filter. Pure. */
export function roomsFor(caller: string | undefined | null, domain?: string): string[] {
  const permitted = [...OPEN_ROOMS, ...RING_ROOMS.filter((r) => isLaneAllowed(r, caller))];
  const d = (domain || '').trim().toLowerCase();
  if (!d) return permitted;
  const wanted = DOMAIN_ROOMS[d];
  if (!wanted) return permitted; // unknown domain -> don't silently return nothing
  return permitted.filter((r) => wanted.includes(r));
}

export interface FusedHit {
  score: number;
  source: string;
  text: string;
  /** The index doc id (`{agent}__{entryId}`). Carried through so retracted beliefs can be identified. */
  id?: unknown;
  /** Source path of the parent doc (chunked doc rooms), threaded through for citation. */
  path?: string;
}

/**
 * Reciprocal Rank Fusion across rooms. Scores from different indexes are on different scales and
 * are NOT comparable; RRF fuses by RANK, which is scale-free. k=60 is the standard damping constant.
 * Pure + unit-tested.
 */
export function rrfFuse(
  perRoom: Array<{ room: string; hits: Array<{ score?: number; text: string; id?: unknown; path?: string }> }>,
  top: number,
  k = 60,
): FusedHit[] {
  const fused: FusedHit[] = [];
  for (const { room, hits } of perRoom) {
    hits.forEach((h, i) => {
      fused.push({ score: 1 / (k + (i + 1)), source: room, text: h.text, id: h.id, path: h.path });
    });
  }
  return fused.sort((a, b) => b.score - a.score).slice(0, top);
}

export function registerBrainSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'brain_search',
      category: 'read',
      annotations: {
        title: 'Search the OTCHealth One Brain (federated, always-fresh)',
        description:
          'Hybrid semantic search across the LIVE company brain — federated in parallel over every knowledge room you are permitted to read (memory-exec, commons-company-journal, plus the ring-gated finance/legal rooms for executive lanes) and fused by rank. Always current: it queries the live indexes directly rather than a consolidated copy that can go stale. Beliefs the fleet has retracted (via supersedes) are dropped, so a known-false answer cannot resurface as truth. Operational exhaust (status/episode/heartbeat/digest-style chatter) is excluded by default. Pass include_ops=true to see it. Read-only. Ground answers here and cite. Optional domain filter: exec|commons|ops|finance|legal.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        query: z.string().min(1).describe('Natural-language query.'),
        top: z.number().int().min(1).max(25).optional().describe('Max results (default 8).'),
        domain: z.string().optional().describe('Optional domain filter: exec|commons|ops|finance|legal.'),
        include_ops: z
          .boolean()
          .optional()
          .describe(
            'Include operational exhaust (status/episode/heartbeat/digest-style ledger chatter) that is EXCLUDED by default. Default false. Set true for questions ABOUT the operational chatter itself, e.g. "what has the CFO been working on."',
          ),
      },
      outputShape: {
        matches: z.array(z.unknown()),
        count: z.number(),
        mode: z.string(),
        rooms_searched: z.array(z.string()),
        rooms_failed: z.array(z.string()).optional(),
        retracted_dropped: z.array(z.string()).optional(),
        include_ops: z.boolean(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const top = input.top ?? 8;
        const includeOps = input.include_ops ?? false;
        if (!searchConfigured()) {
          return {
            data: { matches: [], count: 0, mode: 'unconfigured', rooms_searched: [], include_ops: includeOps },
            summary: 'AI Search not configured.',
          };
        }
        const rooms = roomsFor(ctx.callerAgent, input.domain);
        if (rooms.length === 0) {
          return {
            data: { matches: [], count: 0, mode: 'no-rooms', rooms_searched: [], include_ops: includeOps },
            summary: `No readable rooms for domain "${input.domain}".`,
          };
        }

        // Over-fetch per room so RRF has depth to fuse from, then trim to `top`.
        const perRoomTop = Math.min(25, Math.max(top, 10));
        const settled = await Promise.allSettled(
          rooms.map(async (room) => ({ room, res: await hybridSearch(room, input.query, perRoomTop, { includeOps }) })),
        );

        const perRoom: Array<{ room: string; hits: Array<{ score?: number; text: string; id?: unknown }> }> = [];
        const searched: string[] = [];
        const failed: string[] = [];
        for (let i = 0; i < settled.length; i++) {
          const s = settled[i];
          if (s.status === 'fulfilled' && s.value.res) {
            perRoom.push({ room: s.value.room, hits: s.value.res.matches });
            searched.push(s.value.room);
          } else {
            // One dead room must never blank the brain. Degrade, disclose, continue.
            failed.push(rooms[i]);
          }
        }

        // Fuse a WIDER pool first, drop retracted beliefs, and only THEN trim to `top` -- otherwise
        // removing a retracted hit would leave a hole instead of promoting a real result into its place.
        const pool = rrfFuse(perRoom, top * 3);
        const retracted = await retractedIds();
        const { kept, dropped } = filterRetracted(pool, retracted);
        const matches = kept.slice(0, top);

        const data: Record<string, unknown> = {
          matches,
          count: matches.length,
          mode: 'federated-rrf',
          rooms_searched: searched,
          include_ops: includeOps,
        };
        if (failed.length) data.rooms_failed = failed;
        // Disclose retractions rather than silently vanishing them -- an agent should be able to SEE
        // that the brain deliberately withheld a belief the fleet has retracted.
        if (dropped.length) data.retracted_dropped = dropped;

        return {
          data,
          summary:
            `${matches.length} match(es) for "${input.query}" — federated live across ${searched.length} room(s): ${searched.join(', ')}.` +
            (includeOps ? ' Operational chatter (status/episode/heartbeat/digest) INCLUDED.' : '') +
            (dropped.length ? ` Dropped ${dropped.length} RETRACTED belief(s): ${dropped.join(', ')}.` : '') +
            (failed.length ? ` ${failed.length} room(s) unreachable: ${failed.join(', ')}.` : ''),
        };
      },
    },
    callerHash,
  );
}

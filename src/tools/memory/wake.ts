import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import {
  isConfigured as sharedConfigured,
  normalizeAgent,
  readSharedAll,
  readInbound,
  readReconcileMarker,
  type MemoryEntry,
} from '../../memory/store.js';
import { searchMemory } from '../../agentstate/memory.js';
import { listTasks } from '../../agentstate/ledger.js';
import { TASK_STATUSES } from '../../agentstate/agents.js';
type TaskStatus = (typeof TASK_STATUSES)[number];
import { isConfigured as cosmosConfigured } from '../../agentstate/cosmos.js';
import { isConfigured as inboxConfigured, readMessages } from '../../agentstate/queue.js';

/**
 * wake — ONE federated boot call for any agent on any platform. Composes, server-side, everything
 * a waking agent previously had to remember to fetch across 5+ separate calls (and demonstrably
 * forgot to — see memory record m_mrikfrv1_60d479d6, finding F1): the shared-feed pack
 * (status + corrections + decisions), the Cosmos memory-of-record, the agent's ACTIVE work-ledger
 * tasks, an inbox PEEK (never drains — draining stays an explicit inbox_read act), and unreconciled
 * cross-agent inbound notes. Each subsystem is fetched in parallel and error-isolated: one
 * unconfigured/failing store degrades to a per-section error string instead of blanking the wake.
 *
 * Size discipline (finding F6, memory_pack ~70KB JIT-offloads): corrections are superseded-collapsed
 * (a correction referenced by a newer correction's `supersedes` is dropped — the newer one IS the
 * current truth), every record's text is capped (id retained so the full record is one
 * memory_search/task_get away), and per-section counts are bounded.
 *
 * v1.1 follow-up (deliberately not in v1): FLEET-BULLETIN delta via the _BULLETIN_SEEN/<agent>.json
 * blob marker convention fleet-search established (otchealth-claude-tools commit 832e0f99).
 */

const TEXT_CAP = 900;

/** Drop entries a newer entry supersedes; keep newest-first order. Generic (id + optional supersedes)
 * so it works over both the shared-feed MemoryEntry rows AND Cosmos memory-of-record rows. Pure + testable. */
export function collapseSuperseded<T extends { id: string }>(entries: T[]): T[] {
  const superseded = new Set<string>();
  for (const e of entries) {
    const s = (e as unknown as Record<string, unknown>)['supersedes'];
    if (typeof s === 'string' && s) superseded.add(s);
  }
  return entries.filter((e) => !superseded.has(e.id));
}

/** Cap a record's text field, flagging truncation so callers know to fetch the full record by id. Pure + testable. */
export function capText<T extends Record<string, unknown>>(rec: T, cap = TEXT_CAP): T {
  const text = rec['text'];
  if (typeof text !== 'string' || text.length <= cap) return rec;
  return { ...rec, text: `${text.slice(0, cap)} …[truncated ${text.length - cap} chars — fetch full record by id]`, truncated: true };
}

const ACTIVE_STATUSES: TaskStatus[] = ['open', 'claimed', 'in_progress', 'blocked'];

// ---- DOCTRINE-AT-WAKE (Phase 1 cold-start doctrine) ----------------------------------------------
// wake() is every agent's first call on any platform, so it is the natural place to hand back
// standing operating doctrine alongside state: the Definition of Done, the pitfalls most likely to
// repeat, and the non-negotiable standing directives. ADDITIVE ONLY: sourced from data wake ALREADY
// fetches (the shared feed + the Cosmos memory-of-record) — no new store, no new network fetch, and
// no change to any existing wake field.
const DOCTRINE_PITFALL_CAP = 8;
const DOCTRINE_TEXT_CAP = 220;

/** Verbatim per the standing operating doctrine. Every shipped change must clear all five. */
export const DEFINITION_OF_DONE =
  'merged + CI green; deployed + verified; an independent live call; a ledger artifact URI; a monitor whose silence pages';

/** Non-negotiable standing directives, restated on every wake so they cannot be forgotten mid-session. */
export const STANDING_DIRECTIVES: readonly string[] = [
  'Ground-first: retrieve from the brain and ledger before asserting any fact. Never answer from general knowledge, and never a generic disclaimer.',
  'Write-through every fact, decision, and correction the instant it happens. The ledger is the source of truth, not chat memory.',
  'Never commit a secret VALUE into any repo, response, or log. Names are fine, values never.',
  'Never expose real PHI to this non-BAA runtime.',
];

export interface DoctrinePitfall {
  id: string;
  text: string;
  source: 'shared_feed' | 'memory_of_record';
}

export interface Doctrine {
  definition_of_done: string;
  pitfalls: DoctrinePitfall[];
  standing_directives: readonly string[];
}

/** Normalize + cap one candidate pitfall record from either store into a doctrine-ready entry, or
 * null if it carries no usable text. Pure + testable. */
function toDoctrinePitfall(rec: Record<string, unknown>, source: DoctrinePitfall['source']): DoctrinePitfall | null {
  const text = typeof rec['text'] === 'string' ? rec['text'].trim() : '';
  if (!text) return null;
  const capped = text.length > DOCTRINE_TEXT_CAP ? `${text.slice(0, DOCTRINE_TEXT_CAP)}…` : text;
  return { id: typeof rec['id'] === 'string' ? rec['id'] : '', text: capped, source };
}

/**
 * Merge shared-feed + Cosmos pitfall candidates into a deduped, capped, doctrine-ready list. Shared-
 * feed entries (the canonical `type: 'pitfall'` ledger) take priority; Cosmos-sourced pitfalls fill
 * any remaining slots. Both inputs are expected to already be superseded-collapsed by the caller
 * (reusing collapseSuperseded, same as wake already does for corrections). Pure + testable.
 */
export function buildDoctrinePitfalls(
  sharedPitfalls: MemoryEntry[],
  cosmosPitfalls: Record<string, unknown>[],
): DoctrinePitfall[] {
  const out: DoctrinePitfall[] = [];
  const seen = new Set<string>();
  const consider = (candidate: DoctrinePitfall | null): void => {
    if (!candidate || out.length >= DOCTRINE_PITFALL_CAP) return;
    const key = candidate.text.slice(0, 100).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };
  for (const p of sharedPitfalls) consider(toDoctrinePitfall(p as unknown as Record<string, unknown>, 'shared_feed'));
  for (const p of cosmosPitfalls) consider(toDoctrinePitfall(p, 'memory_of_record'));
  return out;
}

/** Build the doctrine block. pitfalls defaults empty (used on the no-agent-identity early return,
 * where DoD + standing directives are still owed even though there is no agent to scope pitfalls to). */
function buildDoctrine(pitfalls: DoctrinePitfall[] = []): Doctrine {
  return { definition_of_done: DEFINITION_OF_DONE, pitfalls, standing_directives: STANDING_DIRECTIVES };
}

export function registerWake(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'wake',
      category: 'read',
      annotations: {
        title: 'Federated agent wake (one-call boot)',
        description:
          'Call this FIRST on wake, on any platform: one call returns your shared-feed pack (latest status, superseded-collapsed corrections, recent decisions), your Cosmos memory-of-record, your ACTIVE work-ledger tasks, an inbox PEEK (nothing is drained), and unreconciled cross-agent inbound notes. Replaces the 5-call boot sequence (memory_pack + memory_search + task_list + inbox_read + memory_inbound) whose steps were routinely skipped. Sections are error-isolated; long texts are capped with ids retained. Ring-safe: shared feed + your own lane only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        agent: z.string().optional().describe('Agent lane to wake; defaults to your token identity (lowercase id, e.g. "cto").'),
        recent_limit: z.number().int().min(1).max(40).optional().describe('Max recent shared-feed entries (default 10).'),
        memory_limit: z.number().int().min(1).max(40).optional().describe('Max Cosmos memory-of-record entries (default 12).'),
        task_limit: z.number().int().min(1).max(50).optional().describe('Max active tasks (default 15).'),
      },
      outputShape: {
        agent: z.string(),
        pack: z.unknown(),
        memory_records: z.array(z.unknown()),
        tasks: z.unknown(),
        inbox: z.unknown(),
        inbound: z.unknown(),
        errors: z.array(z.string()),
        doctrine: z.unknown(),
      },
      handler: async (input, ctx) => {
        const agentRaw = input.agent || ctx.callerAgent;
        if (!agentRaw) {
          return {
            data: {
              agent: '',
              pack: null,
              memory_records: [],
              tasks: null,
              inbox: null,
              inbound: null,
              errors: ['No agent specified and no caller identity; pass agent.'],
              doctrine: buildDoctrine(),
            },
            summary: 'wake: no agent identity.',
          };
        }
        const agent = normalizeAgent(agentRaw);
        const recentLimit = input.recent_limit ?? 10;
        const memoryLimit = input.memory_limit ?? 12;
        const taskLimit = input.task_limit ?? 15;
        const errors: string[] = [];

        // Fetched ONCE and shared by packP + the doctrine pitfall digest below, so doctrine never
        // doubles the shared-feed network fetch.
        const sharedFeedP: Promise<MemoryEntry[]> = sharedConfigured() ? readSharedAll() : Promise.resolve([]);

        const packP = (async () => {
          if (!sharedConfigured()) return { configured: false, status: null, corrections: [], decisions: [], recent: [], count: 0 };
          const mine = (await sharedFeedP).filter((r) => r.agent === agent); // newest-first
          const status = mine.find((r) => r.type === 'status') ?? null;
          const corrections = collapseSuperseded(mine.filter((r) => r.type === 'correction')).slice(0, 8);
          const decisions = mine.filter((r) => r.type === 'decision').slice(0, 8);
          const recent = mine.slice(0, recentLimit);
          return {
            configured: true,
            status: status ? capText(status as unknown as Record<string, unknown>) : null,
            corrections: corrections.map((c) => capText(c as unknown as Record<string, unknown>)),
            decisions: decisions.map((d) => capText(d as unknown as Record<string, unknown>)),
            recent: recent.map((r) => capText(r as unknown as Record<string, unknown>)),
            count: mine.length,
          };
        })();

        const memP = (async () => {
          if (!cosmosConfigured()) return { configured: false, records: [] as Record<string, unknown>[] };
          const records = await searchMemory({ agent, limit: memoryLimit });
          return { configured: true, records: records.map((r) => capText(r as unknown as Record<string, unknown>)) };
        })();

        const tasksP = (async () => {
          if (!cosmosConfigured()) return { configured: false, active: [] as Record<string, unknown>[], counts: {} as Record<string, number> };
          const all = await listTasks({ owner_agent: agent, limit: 50 });
          const counts: Record<string, number> = {};
          for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;
          const active = all
            .filter((t) => (ACTIVE_STATUSES as string[]).includes(String(t.status)))
            .slice(0, taskLimit)
            .map((t) => capText(t as unknown as Record<string, unknown>, 600));
          return { configured: true, active, counts };
        })();

        const inboxP = (async () => {
          if (!inboxConfigured()) return { configured: false, count: 0, preview: [] as unknown[] };
          const msgs = await readMessages(agent, { max: 8, ack: false }); // PEEK — wake never drains
          return { configured: true, count: msgs.length, preview: msgs.slice(0, 5).map((m) => capText(m as unknown as Record<string, unknown>, 400)) };
        })();

        const inboundP = (async () => {
          if (!sharedConfigured()) return { configured: false, count: 0, sinceMarker: '', notes: [] as unknown[] };
          const marker = await readReconcileMarker(agent);
          const notes = await readInbound(agent, marker);
          return { configured: true, count: notes.length, sinceMarker: marker, notes: notes.map((n) => capText(n as unknown as Record<string, unknown>)) };
        })();

        // Doctrine pitfalls (shared-feed half): the shared feed's own type='pitfall' rows,
        // superseded-collapsed with the same helper wake already uses for corrections. Reuses
        // sharedFeedP above — no extra network fetch.
        const doctrinePitfallsSharedP = (async () => {
          const mine = (await sharedFeedP).filter((r) => r.agent === agent);
          return collapseSuperseded(mine.filter((r) => r.type === 'pitfall'));
        })();

        const [pack, memory, tasks, inbox, inbound, doctrinePitfallsShared] = await Promise.allSettled([
          packP,
          memP,
          tasksP,
          inboxP,
          inboundP,
          doctrinePitfallsSharedP,
        ]);
        const take = <T>(r: PromiseSettledResult<T>, label: string, fallback: T): T => {
          if (r.status === 'fulfilled') return r.value;
          errors.push(`${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
          return fallback;
        };

        const packV = take(pack, 'pack', { configured: false, status: null, corrections: [], decisions: [], recent: [], count: 0 });
        const memV = take(memory, 'memory_records', { configured: false, records: [] });
        const tasksV = take(tasks, 'tasks', { configured: false, active: [], counts: {} });
        const inboxV = take(inbox, 'inbox', { configured: false, count: 0, preview: [] });
        const inboundV = take(inbound, 'inbound', { configured: false, count: 0, sinceMarker: '', notes: [] });
        const doctrinePitfallsSharedV = take(doctrinePitfallsShared, 'doctrine_pitfalls', [] as MemoryEntry[]);

        const activeCount = (tasksV as { active: unknown[] }).active.length;
        const summaryBits = [
          `pack ${(packV as { count: number }).count}`,
          `mem ${(memV as { records: unknown[] }).records.length}`,
          `tasks ${activeCount} active`,
          `inbox ${(inboxV as { count: number }).count}`,
          `inbound ${(inboundV as { count: number }).count}`,
        ];

        // Doctrine pitfalls (Cosmos half): reuses the memory_records ALREADY fetched above (memV) —
        // no extra fetch. ADDITIVE: this only READS memV.records; it never changes what is returned
        // under the existing `memory_records` field.
        const cosmosPitfalls = (memV as { records: Record<string, unknown>[] }).records.filter(
          (r) => r['kind'] === 'pitfall',
        );
        const doctrine = buildDoctrine(buildDoctrinePitfalls(doctrinePitfallsSharedV, cosmosPitfalls));

        return {
          data: { agent, pack: packV, memory_records: (memV as { records: unknown[] }).records, tasks: tasksV, inbox: inboxV, inbound: inboundV, errors, doctrine },
          summary: `wake(${agent}): ${summaryBits.join(' · ')}${errors.length ? ` · ${errors.length} section error(s)` : ''}.${activeCount ? ` ⚠ ${activeCount} active task(s) awaiting you.` : ''}`,
        };
      },
    },
    callerHash,
  );
}

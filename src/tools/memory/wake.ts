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
import { isM365StaticAuth } from '../../server/request-context.js';

/**
 * wake — ONE federated boot call for any agent on any platform. Composes, server-side, everything
 * a waking agent previously had to remember to fetch across 5+ separate calls (and demonstrably
 * forgot to — see memory record m_mrikfrv1_60d479d6, finding F1): the shared-feed pack
 * (status + corrections + decisions), the Cosmos memory-of-record, the agent's ACTIVE work-ledger
 * tasks, an inbox PEEK (never drains — draining stays an explicit inbox_read act), and unreconciled
 * cross-agent inbound notes. Each subsystem is fetched in parallel and error-isolated: one
 * unconfigured/failing store degrades to a per-section error string instead of blanking the wake.
 * (W1-6 audit, 2026-07-17: re-verified every sub-read below is an immediately-invoked async IIFE
 * assigned to a promise before the shared Promise.allSettled, so every underlying network call is
 * already in flight concurrently, matching brain-search.ts's per-room fan-out pattern. No sequential
 * await chain was found, so no change was needed here.)
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

// ---- M365 LITE WAKE (2026-07-26) ------------------------------------------------------------------
// Deep Research Mode (5-subagent fan-out) found Microsoft documents a real, if informal, response-
// size ceiling for a single RemoteMCPServer plugin tool result (Microsoft Learn declarative-agent-
// architecture doc: ~25-item plugin response limit, ~4,096-token overall budget) -- exceeding it
// produces exactly the "NO CONTENT AVAILABLE" symptom Matt hit live on wake(). This is DIFFERENT
// from, and IN ADDITION TO, the 2026-07-25 fix below (isM365StaticAuth() skips our own JIT-offload
// stub for M365 callers): that fix addressed Copilot's orchestrator not reliably chaining into a
// follow-up gateway_fetch_result call when it sees an offload stub. Skipping offload alone still
// leaves the FULL wake payload (many records at up to 900 chars each, routinely >40KB) well over
// Copilot's own ceiling for a busy agent -- so the symptom persisted even after that fix.
//
// FIX: for M365 static-auth callers specifically, return a condensed object that is SMALL AND
// USEFUL ON ITS OWN -- not a "fetch more" stub Copilot won't reliably chase (the exact failure mode
// the 2026-07-25 fix was working around), just every field capped much harder. Field NAMES and
// SHAPES are kept identical to the full response (pack/memory_records/tasks/inbox/inbound/errors/
// doctrine all remain objects/arrays of the same kind) so this cannot violate the tool's declared
// outputSchema -- only the CONTENT inside each field shrinks. Every other engine (Claude Code,
// Hyperagent, and any non-M365 caller) is completely unchanged and still gets the full object.
// Target: comfortably under 8KB serialized (well under both the ~25-item and ~4,096-token limits).
// TIGHTENED (2026-07-28, 3rd/4th review round): the original 150/3-item caps were sized against the
// text/was fields alone. Once the generic recursive bound (boundValue below) also caps tags/notes/
// title/artifact_uri on EVERY record, a maximally-adversarial-but-realistic record (every field at
// its cap simultaneously) still totals more than the old caps left margin for -- measured via the
// wire-envelope test in wake.m365-lite.test.ts, which mirrors registry.ts's actual pretty-printed +
// duplicated-in-structuredContent response shape rather than a single minified copy.
export const M365_LITE_TEXT_CAP = 100;
const M365_LITE_LIST_CAP = 2;
const M365_LITE_DOCTRINE_PITFALL_CAP = 3;

interface WakePack {
  configured: boolean;
  status: Record<string, unknown> | null;
  corrections: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  recent: Record<string, unknown>[];
  count: number;
}
interface WakeTasks {
  configured: boolean;
  active: Record<string, unknown>[];
  counts: Record<string, number>;
}
interface WakeInbox {
  configured: boolean;
  count: number;
  preview: unknown[];
}
interface WakeInbound {
  configured: boolean;
  count: number;
  sinceMarker: string;
  notes: unknown[];
}
export interface WakeFullData {
  agent: string;
  pack: WakePack;
  memory_records: Record<string, unknown>[];
  tasks: WakeTasks;
  inbox: WakeInbox;
  inbound: WakeInbound;
  errors: string[];
  doctrine: Doctrine;
}

/** Cosmos/CosmosDB internal bookkeeping fields (_rid/_self/_etag/_attachments/_ts) that ride along
 * on every memory/task record returned from the store. Pure implementation-detail noise with zero
 * value to an M365 caller -- stripped entirely (not merely capped) on the lite path to reclaim that
 * space for content. Non-lite (full) callers are unaffected. */
const COSMOS_INTERNAL_FIELDS = new Set(['_rid', '_self', '_etag', '_attachments', '_ts']);

const M365_LITE_MAX_ARRAY_ITEMS = 2; // bounds any NESTED array (tags, notes, whatever comes next)
const M365_LITE_MAX_DEPTH = 6; // safety valve against pathological nesting; real records are shallow

/**
 * Recursively bound an arbitrary JSON value for the M365-lite path: every string longer than
 * M365_LITE_TEXT_CAP is truncated (wherever it lives, at any depth, under any field name); every
 * array longer than M365_LITE_MAX_ARRAY_ITEMS is truncated; every Cosmos-internal bookkeeping key is
 * dropped. Numbers/booleans/null pass through unchanged. Pure, generic, field-name-agnostic.
 *
 * WHY THIS EXISTS (2026-07-28, replacing a field-name ALLOWLIST that failed FOUR times in a row on
 * this exact function): the original approach special-cased one field name at a time as each one
 * was found live in production -- 'text' (the original design), then 'was' (pass 1, a correction's
 * prior-belief text), then 'description' (pass 2, a task's long-form content, found by re-measuring
 * the LIVE gateway after pass 1 barely moved the needle: ~24.3KB vs ~24.5KB before), then 'notes' (a
 * review finding: an unbounded string[] task_update appends to over a task's lifetime, which no
 * scalar-field cap could ever touch since it's an array, not a string). A FIFTH review comment named
 * the actual structural problem directly: "one such record can push wake() back over the ceiling"
 * because ANY not-yet-listed field -- tags arrays, title, artifact_uri, or a field nobody has hit
 * yet -- was still completely unbounded. A denylist of field NAMES can never be complete; a
 * recursive bound on VALUE SHAPE (string, array, object) by construction cannot miss a future field,
 * because it never looks at field names at all except to strip the known-noise Cosmos ones. */
function boundValue(value: unknown, depth: number): unknown {
  if (depth > M365_LITE_MAX_DEPTH) return value;
  if (typeof value === 'string') {
    if (value.length <= M365_LITE_TEXT_CAP) return value;
    return `${value.slice(0, M365_LITE_TEXT_CAP)} …[truncated ${value.length - M365_LITE_TEXT_CAP} chars]`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, M365_LITE_MAX_ARRAY_ITEMS).map((v) => boundValue(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (COSMOS_INTERNAL_FIELDS.has(k)) continue;
      out[k] = boundValue(v, depth + 1);
    }
    return out;
  }
  return value; // number | boolean | null | undefined
}

/** Bound one wake() record (or null, e.g. pack.status when nothing is set yet) for the lite path.
 * Thin wrapper over boundValue that also stamps `truncated: true` whenever the record's own
 * serialized size actually shrank, mirroring the informational marker the rest of the codebase's
 * capText() convention uses (nothing downstream machine-checks this flag -- it's for a human/LLM
 * reader glancing at the JSON -- so an approximate whole-record signal is sufficient; exact per-
 * field parity with capText is not required). */
function boundRecord(rec: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!rec) return rec;
  const bounded = boundValue(rec, 0) as Record<string, unknown>;
  if (JSON.stringify(bounded).length < JSON.stringify(rec).length) bounded.truncated = true;
  return bounded;
}

/** Condense a full wake() response for M365 static-auth callers. Pure + testable -- see the header
 * comment above for the full rationale, and boundValue's header for why this is now a generic
 * recursive bound rather than a field-name allowlist (four prior field-specific patches in a row on
 * this exact function is what forced the rewrite). Field names/top-level SHAPES are kept identical
 * to the full response so this cannot violate the tool's declared outputSchema -- only the CONTENT
 * inside each field shrinks. */
export function buildM365LiteWake(full: WakeFullData): Record<string, unknown> {
  return {
    agent: full.agent,
    pack: {
      ...full.pack,
      status: boundRecord(full.pack.status),
      corrections: full.pack.corrections.slice(0, M365_LITE_LIST_CAP).map((c) => boundRecord(c)),
      decisions: full.pack.decisions.slice(0, M365_LITE_LIST_CAP).map((d) => boundRecord(d)),
      recent: [], // dropped for size on the M365-lite path; call memory_recall for the full feed
    },
    memory_records: full.memory_records.slice(0, M365_LITE_LIST_CAP).map((r) => boundRecord(r)),
    tasks: {
      ...full.tasks,
      active: full.tasks.active.slice(0, M365_LITE_LIST_CAP).map((t) => boundRecord(t)),
    },
    inbox: { ...full.inbox, preview: [] },
    inbound: { ...full.inbound, notes: [] },
    errors: full.errors,
    doctrine: { ...full.doctrine, pitfalls: full.doctrine.pitfalls.slice(0, M365_LITE_DOCTRINE_PITFALL_CAP) },
  };
}

// ---- BRIEF WAKE (P2-3, 2026-07-29) ----------------------------------------------------------------
// Real bug report (CFO agent, a long-lived session with substantial accumulated memory, NOT the
// M365 lane the lite path above exists for): wake() and memory_pack() were BOTH routinely landing
// in the 90-100KB range and JIT-offloading (see result-store.ts, THRESHOLD_CHARS=40000), costing
// 4+ gateway_fetch_result calls each before any real work starts. wake() was built specifically to
// REPLACE a 5-call boot sequence (see the tool description above); at that size it had quietly
// reintroduced most of the cost it exists to remove. Root cause, once measured: with the DEFAULT
// limits (8 corrections, 8 decisions, 10 recent, 12 memory records, 15 tasks) each capped at
// TEXT_CAP=900 chars, the section totals alone run past 40KB raw text before the registry's
// pretty-print + structuredContent duplication (see registry.ts buildTextContent) roughly doubles
// it again -- and `pack.recent` (mixed-type raw shared-feed entries) substantially DUPLICATES what
// `pack.corrections`/`pack.decisions` already show, which is exactly the "much of the payload is
// superseded or duplicated between the two [wake and memory_pack]" complaint in the bug report.
//
// FIX: an explicit `brief: true` input (default false -- ADDITIVE, `brief: false` is byte-for-byte
// today's existing behavior, nothing above this line changes). When true:
//   - every list is collapseSuperseded()'d first -- the SAME helper this file already uses for
//     shared-feed corrections/pitfalls, now ALSO applied to pack.decisions and to the Cosmos
//     memory_records (neither of which collapseSuperseded touched before this fix, even in full
//     mode -- a real gap, since Cosmos memory records can carry `supersedes` too, see
//     agentstate/memory.ts's MemoryRecord). No new supersede-detection logic is invented here; this
//     reuses the existing write-time detector (memory/auto-supersede-runtime.ts) and read-time
//     retraction contract (memory/retractions.ts) already establish -- collapseSuperseded is simply
//     the in-process equivalent of that same "a newer entry with `supersedes` retires the older
//     one" rule, applied to whatever list wake already has in hand.
//   - `pack.recent` is dropped entirely (the biggest duplicate-noise contributor -- corrections,
//     decisions, and status above already surface the current-truth entries from the same feed).
//   - every record's text is capped much harder (WAKE_BRIEF_TEXT_CAP) and list lengths are
//     tightened (WAKE_BRIEF_LIST_CAP / WAKE_BRIEF_MEMORY_CAP / WAKE_BRIEF_TASK_CAP / *_INBOX_CAP /
//     *_INBOUND_CAP), reusing the existing capText helper -- no new truncation logic.
//   - `id` is never touched (capText/collapseSuperseded both preserve it), so every entry in a brief
//     response can be resolved to its full record via memory_search / task_get (no new drill-down
//     tool is built here; see the PR description for that as a natural follow-on).
// Unlike the M365-lite path this is a GENERAL-PURPOSE size lever any caller can opt into (Claude
// Code, Hyperagent, or a long-lived agent session with a large ledger) -- it is not tied to a
// specific platform's response-size ceiling, just to "give me the current truth, small."
export const WAKE_BRIEF_TEXT_CAP = 300;
export const WAKE_BRIEF_LIST_CAP = 6; // pack.corrections / pack.decisions
export const WAKE_BRIEF_MEMORY_CAP = 8; // memory_records (Cosmos)
export const WAKE_BRIEF_TASK_CAP = 10; // tasks.active
export const WAKE_BRIEF_INBOX_CAP = 3; // inbox.preview
export const WAKE_BRIEF_INBOUND_CAP = 3; // inbound.notes

/** collapseSuperseded operates on `T extends { id: string }`; wrap it for the loosely-typed
 * Record<string, unknown>[] shapes wake's sub-sections carry, without losing any fields (the
 * generic itself only ever reads `id`/`supersedes`, so this cast is safe -- mirrors the "Cosmos
 * rows" usage already pinned in wake.test.ts). Pure. */
function collapseSupersededRecords(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return collapseSuperseded(entries as unknown as Array<{ id: string }>) as unknown as Record<string, unknown>[];
}

/** Cap one record's text at the brief cap and, for Cosmos-backed records (memory_records,
 * tasks.active), also strip the Cosmos internal bookkeeping fields (reusing the same
 * COSMOS_INTERNAL_FIELDS set the M365-lite path uses) -- pure noise with zero value to a brief
 * caller. Pure. */
function briefBoundRecord(rec: Record<string, unknown>, stripCosmos = false): Record<string, unknown> {
  const capped = capText(rec, WAKE_BRIEF_TEXT_CAP);
  if (!stripCosmos) return capped;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(capped)) {
    if (!COSMOS_INTERNAL_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Condense a full wake() response into a brief, current-truth-only, small working set. Pure +
 * testable. Field names/top-level shapes are kept identical to the full response (same reasoning
 * as buildM365LiteWake above), so this cannot violate the tool's declared outputShape -- only the
 * CONTENT inside each field shrinks (or, for `pack.recent`, is dropped to an empty array).
 */
export function buildBriefWake(full: WakeFullData): Record<string, unknown> {
  const corrections = collapseSupersededRecords(full.pack.corrections)
    .slice(0, WAKE_BRIEF_LIST_CAP)
    .map((c) => briefBoundRecord(c));
  const decisions = collapseSupersededRecords(full.pack.decisions)
    .slice(0, WAKE_BRIEF_LIST_CAP)
    .map((d) => briefBoundRecord(d));
  const memory_records = collapseSupersededRecords(full.memory_records)
    .slice(0, WAKE_BRIEF_MEMORY_CAP)
    .map((r) => briefBoundRecord(r, true));
  const active = full.tasks.active.slice(0, WAKE_BRIEF_TASK_CAP).map((t) => briefBoundRecord(t, true));
  const preview = (full.inbox.preview as Record<string, unknown>[])
    .slice(0, WAKE_BRIEF_INBOX_CAP)
    .map((m) => briefBoundRecord(m));
  const notes = (full.inbound.notes as Record<string, unknown>[])
    .slice(0, WAKE_BRIEF_INBOUND_CAP)
    .map((n) => briefBoundRecord(n));

  return {
    agent: full.agent,
    pack: {
      ...full.pack,
      status: full.pack.status ? briefBoundRecord(full.pack.status) : null,
      corrections,
      decisions,
      recent: [], // dropped for size in brief mode -- corrections/decisions/status above already
      // carry the current-truth entries from this same feed; call wake(brief:false) or
      // memory_pack/memory_recall for the raw recent feed.
    },
    memory_records,
    tasks: { ...full.tasks, active },
    inbox: { ...full.inbox, preview },
    inbound: { ...full.inbound, notes },
    errors: full.errors,
    doctrine: full.doctrine,
  };
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
          'Call this FIRST on wake, on any platform: one call returns your shared-feed pack (latest status, superseded-collapsed corrections, recent decisions), your Cosmos memory-of-record, your ACTIVE work-ledger tasks, an inbox PEEK (nothing is drained), and unreconciled cross-agent inbound notes. Replaces the 5-call boot sequence (memory_pack + memory_search + task_list + inbox_read + memory_inbound) whose steps were routinely skipped. Sections are error-isolated; long texts are capped with ids retained. Pass brief:true on a long-lived session (large ledger) to get only current-truth entries, hard-capped for size, so the response stays inline instead of JIT-offloading. Ring-safe: shared feed + your own lane only.',
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
        brief: z
          .boolean()
          .optional()
          .describe(
            'If true, return only current-truth entries (superseded ones collapsed) with ids for drill-down, hard-capped for size. Defaults to false (unchanged full behavior). Use on a long-lived session whose wake payload is JIT-offloading.',
          ),
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

        const fullData: WakeFullData = {
          agent,
          pack: packV as WakePack,
          memory_records: (memV as { records: Record<string, unknown>[] }).records,
          tasks: tasksV as WakeTasks,
          inbox: inboxV as WakeInbox,
          inbound: inboundV as WakeInbound,
          errors,
          doctrine,
        };

        // M365 LITE WAKE: see the header comment on buildM365LiteWake above. Every other caller
        // (Claude Code, Hyperagent, any non-M365 lane) gets fullData unchanged, UNLESS it opted
        // into brief:true (see the BRIEF WAKE header comment above). M365-lite takes priority when
        // both would apply -- it is a hard platform-ceiling requirement, not a size preference.
        const m365Lite = isM365StaticAuth();
        const brief = !m365Lite && (input.brief ?? false);
        const data = m365Lite ? buildM365LiteWake(fullData) : brief ? buildBriefWake(fullData) : fullData;
        const modeTag = m365Lite ? ' [M365-lite]' : brief ? ' [brief]' : '';

        return {
          data,
          summary: `wake(${agent})${modeTag}: ${summaryBits.join(' · ')}${errors.length ? ` · ${errors.length} section error(s)` : ''}.${activeCount ? ` ⚠ ${activeCount} active task(s) awaiting you.` : ''}`,
        };
      },
    },
    callerHash,
  );
}

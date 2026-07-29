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
import { retractedIds as globalRetractedIds } from '../../memory/retractions.js';

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
export function boundValue(value: unknown, depth: number, textCap: number = M365_LITE_TEXT_CAP): unknown {
  if (depth > M365_LITE_MAX_DEPTH) return value;
  if (typeof value === 'string') {
    if (value.length <= textCap) return value;
    return `${value.slice(0, textCap)} …[truncated ${value.length - textCap} chars]`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, M365_LITE_MAX_ARRAY_ITEMS).map((v) => boundValue(v, depth + 1, textCap));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (COSMOS_INTERNAL_FIELDS.has(k)) continue;
      out[k] = boundValue(v, depth + 1, textCap);
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
 * field parity with capText is not required).
 *
 * `textCap` defaults to M365_LITE_TEXT_CAP so the M365-lite callsite below is completely unchanged.
 * The brief-mode callers (wake.ts's own briefBoundRecord, pack.ts's boundNonNull) pass their own
 * *_BRIEF_TEXT_CAP explicitly -- review finding, 2026-07-30: WAKE_BRIEF_TEXT_CAP/PACK_BRIEF_TEXT_CAP
 * were exported and documented as the brief-mode cap but never actually threaded into boundValue,
 * so brief mode silently truncated at the M365-lite path's 100-char cap regardless of their declared
 * value -- dead, misleading constants. Fixed by threading the cap through instead of hardcoding it;
 * the constants are now set to the value already measured safe under the 40KB offload budget (see
 * each constant's own comment for why a much looser cap was not simply restored). */
export function boundRecord(rec: Record<string, unknown> | null, textCap: number = M365_LITE_TEXT_CAP): Record<string, unknown> | null {
  if (!rec) return rec;
  const bounded = boundValue(rec, 0, textCap) as Record<string, unknown>;
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
// WAKE_BRIEF_TEXT_CAP was 220 in the first pass but never actually threaded into boundValue (it
// silently truncated at the M365-lite path's 100-char cap instead -- a dead, misleading constant;
// review finding, 2026-07-30). Now that it is genuinely threaded through (see boundRecord above),
// restoring 220 would roughly double the per-string-field cost across every capped record and blow
// well past the 40000-char offload threshold this whole mode exists to stay under (measured: even
// AT the accidental 100-char cap, the realistic wire-envelope fixture landed at 40170 bytes, over
// budget, before WAKE_BRIEF_RECENT_FACT_CAP was tightened from 5 to 3 to compensate). 100 is the
// value already proven safe under that budget; kept explicit (not silently reusing
// M365_LITE_TEXT_CAP by import) so this tool's own cap can be tuned independently later.
export const WAKE_BRIEF_TEXT_CAP = 100;
export const WAKE_BRIEF_LIST_CAP = 5; // pack.corrections / pack.decisions
export const WAKE_BRIEF_MEMORY_CAP = 6; // memory_records (Cosmos)
export const WAKE_BRIEF_TASK_CAP = 8; // tasks.active
export const WAKE_BRIEF_INBOX_CAP = 3; // inbox.preview
export const WAKE_BRIEF_INBOUND_CAP = 3; // inbound.notes

/**
 * Compute the GLOBAL set of retracted ids across every entry passed in, regardless of type or
 * which list it originally came from. Pure. Trims each `supersedes` value before adding it,
 * matching memory/retractions.ts's collectRetracted contract exactly (review finding, 2026-07-30:
 * a stored `supersedes` value like `" c1 "` would otherwise be filtered by normal memory retrieval
 * but survive here untrimmed and never match a real id).
 *
 * This is the FALLBACK used only when the caller does not supply an externally-computed retraction
 * set (see buildBriefWake/buildBriefPack's `externalRetractedIds` param) -- e.g. in unit tests that
 * exercise cross-type retraction within a single synthetic payload without a live store. In
 * production, `registerWake`'s handler calls memory/retractions.ts's `retractedIds()` instead (see
 * that call site for why): it queries the FULL Cosmos supersedes-bearing set, not merely whatever
 * `memory_limit`-capped slice this function's `full.memory_records` argument would otherwise be
 * confined to.
 *
 * WHY THIS EXISTS (review finding, 2026-07-30): collapseSupersededRecords only ever sees the
 * SINGLE list it's called on -- calling it separately on corrections, then separately on
 * decisions, then separately on memory_records means a retraction that crosses one of those
 * boundaries (a decision superseding a correction, a fact superseding a decision, a Cosmos
 * memory_record superseding a shared-feed entry or vice versa) is invisible to whichever call
 * never saw the retracting entry in its own slice. Brief mode compounds this: it also DROPS
 * `pack.recent` (or did -- see buildBriefRecentFacts below), so a retracting entry that only
 * exists there was doubly invisible. The fix is structural, not a bigger allowlist: compute one
 * id-set from EVERY entry available (every type, every source, unsliced) BEFORE any type-specific
 * filtering/capping happens, then filter every downstream list through that same set. */
export function computeRetractedIds(...entryLists: Array<Array<{ id?: unknown; supersedes?: unknown }>>): Set<string> {
  const retracted = new Set<string>();
  for (const list of entryLists) {
    for (const e of list) {
      const s = e.supersedes;
      if (typeof s === 'string' && s.trim()) retracted.add(s.trim());
    }
  }
  return retracted;
}

/** Cap one record at the brief cap using the SAME generic recursive bound the M365-lite path
 * uses (boundRecord/boundValue above) -- not the field-specific capText, which only ever touches
 * a `text` property and was proven insufficient by the M365-lite path's own history (four
 * field-specific patches in a row before the recursive rewrite; see boundValue's header). Reusing
 * that already-proven fix here, rather than the older capText, is the actual size guarantee: a
 * real Task's long `description`/`notes[]` or a real inbox message's `subject`/`body` are bounded
 * by field SHAPE, not by matching a hardcoded field name. For Cosmos-backed records
 * (memory_records, tasks.active) also strips the Cosmos internal bookkeeping fields. Pure. */
function briefBoundRecord(rec: Record<string, unknown>, stripCosmos = false): Record<string, unknown> {
  const bounded = boundValue(rec, 0, WAKE_BRIEF_TEXT_CAP) as Record<string, unknown>;
  if (JSON.stringify(bounded).length < JSON.stringify(rec).length) bounded.truncated = true;
  if (!stripCosmos) return bounded;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bounded)) {
    if (!COSMOS_INTERNAL_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

export const WAKE_BRIEF_RECENT_FACT_CAP = 3; // pack.recent, brief mode: bounded fact/pitfall subset, not emptied

/**
 * Build the brief-mode replacement for `pack.recent`: instead of dropping it to `[]` (which loses
 * every unsuperseded 'fact'/'pitfall' entry entirely, since corrections/decisions above are
 * type-filtered and never carry those types), keep a small, retraction-filtered, capped subset of
 * the non-correction/non-decision/non-status types (status is excluded too -- review finding,
 * 2026-07-30: `rawMine` is the complete feed and DOES contain the status row, which would otherwise
 * duplicate `pack.status` and consume one of the few recent slots). `rawMine` is the COMPLETE
 * unsliced per-agent shared feed (not the already-capped `full.pack.recent`), so this can find
 * fact/pitfall entries beyond whatever recent_limit happened to cap the full-mode `recent` slice
 * to. `recentCap` lets the caller respect its own recent_limit input (review finding, 2026-07-30:
 * a caller passing recent_limit:1 expects at most 1 recent entry back, not the brief mode's own
 * fixed cap regardless of what was asked for) -- it is min()'d against WAKE_BRIEF_RECENT_FACT_CAP
 * by the caller before this function ever sees it, so this function's own contract is simply "cap
 * at whatever is passed." Pure.
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
    .map((r) => briefBoundRecord(r));
}

/**
 * Condense a full wake() response into a brief, current-truth-only, small working set. Pure +
 * testable. Field names/top-level shapes are kept identical to the full response (same reasoning
 * as buildM365LiteWake above), so this cannot violate the tool's declared outputShape -- only the
 * CONTENT inside each field shrinks.
 *
 * `rawMine` is the COMPLETE, unsliced per-agent shared feed (every type, not capped by
 * recent_limit) -- passed separately from `full` (never stored inside WakeFullData/WakePack,
 * which IS the literal full-mode response shape; adding it there would leak an extra field into
 * every non-brief caller's payload, the opposite of this fix's purpose). It exists so retraction
 * and the brief recent-facts list can see entries beyond whatever the already-capped
 * corrections/decisions/recent slices happened to include. Optional + defaults to the union of
 * the already-capped slices for callers (tests) that don't have the raw feed handy -- correctness
 * degrades gracefully to "as good as the old per-list behavior," it never throws.
 *
 * `externalRetractedIds`, if supplied, is used INSTEAD OF the locally-derived computeRetractedIds
 * set. The real handler passes memory/retractions.ts's `retractedIds()` here -- the canonical,
 * already-tested, fail-open, TTL-cached global retraction set spanning the COMPLETE shared feed AND
 * a dedicated Cosmos query for every supersedes-bearing row (not merely the memory_limit-capped
 * slice `full.memory_records` would otherwise confine retraction-detection to; review finding,
 * 2026-07-30). Omitted (the default) in tests, which fall back to computeRetractedIds over exactly
 * what the synthetic fixture provides -- sufficient for pinning within-payload cross-type/cross-
 * store retraction behavior without mocking the live store.
 *
 * `recentLimit`, if supplied, is min()'d against WAKE_BRIEF_RECENT_FACT_CAP so a caller's own
 * recent_limit input is honored (never exceeded) even in brief mode; omitted defaults to the cap.
 */
export function buildBriefWake(
  full: WakeFullData,
  rawMine?: Record<string, unknown>[],
  externalRetractedIds?: Set<string>,
  recentLimit?: number,
): Record<string, unknown> {
  const mine = rawMine ?? [...full.pack.corrections, ...full.pack.decisions, ...full.pack.recent];

  // ONE global retracted-id set. Prefer the externally-supplied (canonical, whole-store) set; fall
  // back to deriving one from whatever this call was given -- every type, every source (shared feed
  // AND Cosmos memory_records) -- before any type-specific filtering. See computeRetractedIds's
  // header for why a per-list collapse cannot catch a cross-type or cross-store retraction, and why
  // even this fallback's `full.memory_records` is a bounded slice, not the complete Cosmos set.
  const retractedIds = externalRetractedIds ?? computeRetractedIds(mine, full.memory_records);

  const notRetracted = (r: Record<string, unknown>) => {
    const id = r['id'];
    return !(typeof id === 'string' && retractedIds.has(id));
  };

  const corrections = full.pack.corrections
    .filter(notRetracted)
    .slice(0, WAKE_BRIEF_LIST_CAP)
    .map((c) => briefBoundRecord(c));
  const decisions = full.pack.decisions
    .filter(notRetracted)
    .slice(0, WAKE_BRIEF_LIST_CAP)
    .map((d) => briefBoundRecord(d));
  const memory_records = full.memory_records
    .filter(notRetracted)
    .slice(0, WAKE_BRIEF_MEMORY_CAP)
    .map((r) => briefBoundRecord(r, true));
  const active = full.tasks.active.slice(0, WAKE_BRIEF_TASK_CAP).map((t) => briefBoundRecord(t, true));
  const preview = (full.inbox.preview as Record<string, unknown>[])
    .slice(0, WAKE_BRIEF_INBOX_CAP)
    .map((m) => briefBoundRecord(m));
  // inbound notes ARE shared-feed MemoryEntry rows (unlike inbox.preview, which is a queue message
  // with no `supersedes` contract), so they must pass through the same global retraction filter --
  // review finding, 2026-07-30: this list previously skipped notRetracted entirely.
  const notes = (full.inbound.notes as Record<string, unknown>[])
    .filter(notRetracted)
    .slice(0, WAKE_BRIEF_INBOUND_CAP)
    .map((n) => briefBoundRecord(n));
  const recentCap = Math.min(WAKE_BRIEF_RECENT_FACT_CAP, recentLimit ?? WAKE_BRIEF_RECENT_FACT_CAP);
  const recent = buildBriefRecentFacts(mine, retractedIds, recentCap);

  // status can itself be retracted (memory_remember allows `supersedes` on every entry type,
  // including a later fact/correction retracting the latest status row) -- review finding,
  // 2026-07-30: this previously bypassed notRetracted entirely and could return a known-stale
  // status as current truth even while the SAME id was filtered out of every other section.
  const statusId = full.pack.status?.['id'];
  const statusRetracted = typeof statusId === 'string' && retractedIds.has(statusId);
  const status = full.pack.status && !statusRetracted ? briefBoundRecord(full.pack.status) : null;

  // doctrine.pitfalls is built upstream (buildDoctrine, shared with full mode) from its own
  // separately-collapsed shared-feed + Cosmos pitfall lists, so it can carry an id this same global
  // retraction pass has just dropped from memory_records/corrections/decisions/recent -- review
  // finding, 2026-07-30: "brief mode filters retractions across all sections" was not true of
  // doctrine. Filtered here, scoped to brief mode's own returned object only (full.doctrine, and
  // full mode's response, are untouched).
  const pitfalls = full.doctrine.pitfalls.filter((p) => !retractedIds.has(p.id));

  return {
    agent: full.agent,
    pack: {
      ...full.pack,
      status,
      corrections,
      decisions,
      recent, // a bounded, retraction-filtered fact/pitfall subset -- NOT emptied (see
      // buildBriefRecentFacts: dropping this entirely used to lose every current fact/pitfall,
      // since corrections/decisions above are type-filtered and never carry those types).
    },
    memory_records,
    tasks: { ...full.tasks, active },
    inbox: { ...full.inbox, preview },
    inbound: { ...full.inbound, notes },
    errors: full.errors,
    doctrine: { ...full.doctrine, pitfalls },
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
          'Call this FIRST on wake, on any platform: one call returns your shared-feed pack (latest status, superseded-collapsed corrections, recent decisions), your Cosmos memory-of-record, your ACTIVE work-ledger tasks, an inbox PEEK (nothing is drained), and unreconciled cross-agent inbound notes. Replaces the 5-call boot sequence (memory_pack + memory_search + task_list + inbox_read + memory_inbound) whose steps were routinely skipped. Sections are error-isolated; long texts are capped with ids retained. Pass brief:true on a long-lived session (large ledger) to get only current-truth entries (retracted/superseded entries filtered out across ALL sections, not just within one), hard-capped for size, so the response stays inline instead of JIT-offloading. DRILL-DOWN CAVEAT: task_get resolves a truncated task by id; memory_search resolves a truncated Cosmos memory_record by id. Neither resolves a truncated shared-feed correction/decision/pack.recent entry, or a truncated inbox/inbound entry -- for those, re-call wake(brief:false) or memory_pack(brief:false) to see the untruncated version. Ring-safe: shared feed + your own lane only.',
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
            'If true, return only current-truth entries (retracted/superseded entries filtered out across every section), hard-capped for size, with ids for drill-down. Defaults to false (unchanged full behavior). Use on a long-lived session whose wake payload is JIT-offloading. NO EFFECT for an M365 static-auth caller -- the M365-lite response-size ceiling always takes priority over this flag for that platform (see the M365-lite behavior above).',
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
        // sharedFeedP is already resolved by this point (awaited inside packP above via
        // Promise.allSettled); re-awaiting it here is instant, not a second network fetch. Only
        // done when brief is actually requested, so the non-brief path pays nothing extra.
        //
        // BOTH awaits below are wrapped individually (review finding, 2026-07-30): re-awaiting an
        // already-REJECTED sharedFeedP throws again, and that throw was previously unguarded here --
        // bypassing wake's own documented per-section error isolation (every other section degrades
        // via Promise.allSettled + take() to a fallback with an entry in `errors`; this bare await
        // would instead reject the WHOLE wake() call, but only when brief:true). Each is now caught
        // independently and degrades to `undefined`, which buildBriefWake already handles
        // gracefully (rawMine falls back to the already-capped union; externalRetractedIds falls
        // back to computeRetractedIds over whatever that union + memory_records contain).
        let rawMine: Record<string, unknown>[] | undefined;
        if (brief && sharedConfigured()) {
          try {
            rawMine = (await sharedFeedP).filter((r) => r.agent === agent) as unknown as Record<string, unknown>[];
          } catch (e) {
            errors.push(`brief_raw_feed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // The canonical, whole-store retraction set (memory/retractions.ts) -- spans the COMPLETE
        // shared feed AND a dedicated Cosmos query for every supersedes-bearing row, not merely the
        // memory_limit-capped `fullData.memory_records` slice buildBriefWake's own fallback would
        // otherwise be confined to (review finding, 2026-07-30). retractedIds() is itself fail-open
        // internally (never throws), but this is still guarded defensively since it is a live-store
        // call on the brief-mode-only path.
        let externalRetractedIds: Set<string> | undefined;
        if (brief) {
          try {
            externalRetractedIds = await globalRetractedIds();
          } catch (e) {
            errors.push(`brief_retracted_ids: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const data = m365Lite
          ? buildM365LiteWake(fullData)
          : brief
            ? buildBriefWake(fullData, rawMine, externalRetractedIds, recentLimit)
            : fullData;
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

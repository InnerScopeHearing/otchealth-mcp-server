/**
 * AUTO-JOURNAL — a best-effort, durable "episode" memory of every SUCCESSFUL, MUTATING,
 * non-dry-run tool call. The flagship of the Phase 2 capture plane: a session that writes nothing
 * voluntarily still journals. Wired once into the registerTool wrapper (registry.ts), at the exact
 * seam that already computes `def.category !== 'read'` for the cold-start gate (safety/cold-start.ts).
 *
 * ============================ SHAPE (mirrors safety/cold-start.ts) ============================
 * A PURE core (redactArgs / isPrivilegedOrLegalTool / looksLikeSecretValue / buildEpisodeText /
 * extractArtifactHint / safeAgentForJournal / parseAutoJournalMode) with no IO, no clock, no
 * network -- fully unit-testable without Cosmos or Azure AI Search. A thin IO shell
 * (journalMutation) that owns the actual writeMemory + indexMemoryNow calls.
 *
 * ============================ THE SECRET-VALUE LAW (unwaivable) ============================
 * The auto-journal must NEVER persist a secret value. redactArgs() masks any key matching
 * SECRET_KEY_PATTERN, and separately masks any STRING VALUE that itself looks like a secret blob
 * (PEM block, JWT, long base64 run) regardless of what its key is named -- a value-shaped check,
 * not just a key-name check, because a secret can arrive under an innocuous key. Privileged/legal
 * tools (legal_*, anything with "privileged" in its name) get NO args at all: redactArgs returns
 * null for them, and buildEpisodeText renders only {tool, outcome} when redactedArgs is null.
 *
 * ============================ FAIL-OPEN, NEVER THROW, ZERO LATENCY IMPACT ============================
 * journalMutation is always called via `void journalMutation(...).catch(() => undefined)` at the
 * call site (registry.ts) -- fired WITHOUT awaiting it, so it can never add latency to the tool
 * response it rides on. Its own body is one big try/catch, so the returned promise never rejects
 * either way; the `.catch()` at the call site is defense in depth, matching the repo's existing
 * fire-and-forget convention (see memory/hot-cache.ts's writeCache call). A Cosmos/Search outage
 * degrades to "no episode written" -- it can NEVER fail, slow, or alter the tool call it observes.
 *
 * ============================ NON-PHI RING ============================
 * The gateway is already non-PHI carved (see config/env.ts, catalog/catalog.ts). This module adds
 * no new PHI path: it only ever journals gateway tool-call metadata, never clo-personal content,
 * and privileged/legal tools are stripped down to {tool, outcome} as above.
 */
import { writeMemory } from '../agentstate/memory.js';
import { indexMemory as indexMemoryNow } from '../search/index.js';
import { isConfigured as cosmosConfigured } from '../agentstate/store.js';

// ---- pure core -------------------------------------------------------------------------------

export type AutoJournalMode = 'off' | 'on';

/** Parse AUTO_JOURNAL_MODE, defaulting to 'on' (fail-open toward capturing, mirrors the other
 *  safety-module env parsers: garbage/unset never crashes, it just picks the safe default). Pure. */
export function parseAutoJournalMode(value: string | undefined): AutoJournalMode {
  const v = (value || '').trim().toLowerCase();
  return v === 'off' ? 'off' : 'on';
}

/** A tool name is in the privileged/legal set when it starts with "legal_" or its name contains
 *  "privileged" (catches legal_blob_get/list/put and kb_search_privileged). Case-insensitive. Pure. */
export function isPrivilegedOrLegalTool(toolName: string): boolean {
  const n = (toolName || '').toLowerCase();
  return n.startsWith('legal_') || n.includes('privileged');
}

const PEM_RE = /-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE|RSA PRIVATE KEY|EC PRIVATE KEY)-----/;
const JWT_RE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const LONG_BASE64_RE = /^[A-Za-z0-9+/]{80,}={0,2}$/;

/** True when a string VALUE looks like a secret blob (PEM, JWT, or a long base64 run), independent
 *  of what key it was found under -- a secret can arrive under an innocuous-looking key. Pure. */
export function looksLikeSecretValue(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (PEM_RE.test(v)) return true;
  if (JWT_RE.test(v)) return true;
  if (LONG_BASE64_RE.test(v)) return true;
  return false;
}

/**
 * The secret-value LAW's key-name pattern (quoted verbatim in the PR description / self-audit):
 * drop or mask any key matching this regex. Matches secret/token/password/passwd/pwd/api[_-]?key/
 * credential/authorization/auth/bearer/private[_-]?key/p8/refresh/client[_-]?secret/sas/
 * connection[_-]?string, case-insensitive.
 */
export const SECRET_KEY_PATTERN =
  /secret|token|password|passwd|pwd|api[_-]?key|credential|authorization|auth|bearer|private[_-]?key|p8|refresh|client[_-]?secret|sas|connection[_-]?string/i;

/** Per-value cap (spec: "cap each value to ~200 chars"). */
export const MAX_VALUE_CHARS = 200;
/** Whole-serialized-args cap (spec: "the whole serialized args to ~800 chars"). */
export const MAX_TOTAL_CHARS = 800;
/** Bound how many array elements are considered, so a huge array can't blow past MAX_TOTAL_CHARS
 *  before the total-length truncation even gets a chance to run. */
const MAX_ARRAY_ITEMS = 10;

function redactValue(v: unknown): unknown {
  if (typeof v === 'string') {
    if (looksLikeSecretValue(v)) return '[REDACTED]';
    return v.length > MAX_VALUE_CHARS
      ? `${v.slice(0, MAX_VALUE_CHARS)}…[truncated ${v.length - MAX_VALUE_CHARS} chars]`
      : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY_ITEMS).map(redactValue);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redactValue(vv);
    }
    return out;
  }
  return '[unsupported]';
}

/**
 * Pure redaction of a tool-call args object for episode journaling.
 *  - Privileged/legal tools (isPrivilegedOrLegalTool) return null -- the caller must then journal
 *    ONLY {tool, outcome}, no args at all.
 *  - Otherwise: any key matching SECRET_KEY_PATTERN is masked (at every nesting level); any STRING
 *    VALUE that looks like a secret blob is masked regardless of its key; every surviving value is
 *    capped to MAX_VALUE_CHARS; the whole serialized result is capped to MAX_TOTAL_CHARS.
 * Never throws: defensive try/catch around the whole body (args come from a Zod-parsed JSON-RPC
 * call so this is belt-and-suspenders, not a known failure mode).
 */
export function redactArgs(toolName: string, args: unknown): Record<string, unknown> | null {
  if (isPrivilegedOrLegalTool(toolName)) return null;
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redactValue(v);
    }
    const json = JSON.stringify(out);
    if (json.length > MAX_TOTAL_CHARS) {
      return { _truncated: true, preview: `${json.slice(0, MAX_TOTAL_CHARS)}…` };
    }
    return out;
  } catch {
    return { _redaction_error: true };
  }
}

export interface EpisodeInput {
  tool: string;
  actor: string;
  outcome: string;
  /** null means "privileged/legal tool -- render no args at all" (redactArgs's null case). */
  redactedArgs: Record<string, unknown> | null;
  artifact?: string;
}

/**
 * Pure, deterministic builder for a compact one-line episode summary. Given the SAME input it
 * always produces the SAME output. When redactedArgs is null (privileged/legal), the text carries
 * ONLY the actor/tool/outcome -- no args section, no artifact -- per the secret-value law's
 * privileged-tool carve-out.
 */
export function buildEpisodeText(input: EpisodeInput): string {
  const parts = [`${input.actor} called ${input.tool} (${input.outcome})`];
  if (input.redactedArgs !== null) {
    if (Object.keys(input.redactedArgs).length > 0) {
      parts.push(`args: ${JSON.stringify(input.redactedArgs)}`);
    }
    if (input.artifact) parts.push(`artifact: ${input.artifact}`);
  }
  return parts.join(' | ');
}

const ARTIFACT_KEY_RE = /^(url|html_url|permalink|link|artifact|artifact_url|result_id|id|sha|pr_url|commit_url)$/i;
const MAX_ARTIFACT_CHARS = 300;

function firstArtifactKey(obj: Record<string, unknown>): string | undefined {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim() && ARTIFACT_KEY_RE.test(k)) {
      return v.length > MAX_ARTIFACT_CHARS ? v.slice(0, MAX_ARTIFACT_CHARS) : v;
    }
  }
  return undefined;
}

/**
 * Best-effort, optional heuristic: does the tool's RESULT obviously carry an artifact (a URL or an
 * id)? Scans top-level keys, then one level of nesting under common wrapper keys (record/entry/
 * data), for a key that looks artifact-shaped with a non-empty string value. Never throws.
 */
export function extractArtifactHint(result: unknown): string | undefined {
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
    const obj = result as Record<string, unknown>;
    const direct = firstArtifactKey(obj);
    if (direct) return direct;
    for (const wrapper of ['record', 'entry', 'data', 'task']) {
      const nested = obj[wrapper];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        const hit = firstArtifactKey(nested as Record<string, unknown>);
        if (hit) return hit;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const AGENT_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

/**
 * Best-effort normalize an actor identity for the memory-of-record `agent` partition key. Falls
 * back to 'gateway' for anything that would fail agentstate/agents.ts's normalizeAgent (empty,
 * uppercase-after-lowering-still-invalid, too long, bad chars) -- so a weird/missing caller
 * identity degrades to a labeled journal entry rather than losing the episode. Pure.
 */
export function safeAgentForJournal(actor: string): string {
  const a = (actor || '').trim().toLowerCase();
  return AGENT_RE.test(a) ? a : 'gateway';
}

// ---- IO shell ----------------------------------------------------------------------------------

export interface JournalMutationInput {
  tool: string;
  /** Raw callerAgent from the request context; '' is normalized to 'gateway' inside. */
  actor: string;
  correlationId: string;
  /** The exact args passed to the tool handler (post dry_run/acknowledge_warning strip). */
  args: unknown;
  /** The tool's (guardrail-applied) result, scanned only for an optional artifact hint. */
  result: unknown;
}

/**
 * Write one best-effort "episode" memory of a successful mutating tool call. FAIL-OPEN BY
 * CONSTRUCTION: the entire body is one try/catch, so this promise NEVER rejects. Callers fire it
 * with `void journalMutation(...).catch(() => undefined)` and never await it, so a Cosmos/Search
 * outage can never add latency to, or fail, the tool call that triggered it.
 *
 * Inert when agent-state Cosmos is not configured (mirrors every other agentstate tool's
 * "not configured" no-op). Persists via the SAME path every other durable memory uses:
 * writeMemory (Cosmos, the verbatim system-of-record) + indexMemoryNow (write-through into
 * memory-exec so it does not wait for the 6-hourly reindex) -- see agentstate/memory-write.ts for
 * the sibling call shape this mirrors.
 */
export async function journalMutation(input: JournalMutationInput): Promise<void> {
  try {
    if (!cosmosConfigured()) return;
    const actor = safeAgentForJournal(input.actor); // '' or malformed both fall back to 'gateway'
    const redacted = redactArgs(input.tool, input.args);
    const isPrivileged = redacted === null;
    const artifact = isPrivileged ? undefined : extractArtifactHint(input.result);
    const text = buildEpisodeText({
      tool: input.tool,
      actor,
      outcome: 'success',
      redactedArgs: redacted,
      artifact,
    });
    const record = await writeMemory({
      agent: actor,
      kind: 'episode',
      text,
      tags: ['auto-journal', input.tool],
      source: `correlation:${input.correlationId}`,
    });
    await indexMemoryNow({
      agent: record.agent,
      id: record.id,
      type: record.kind,
      ts: record.created_at,
      tags: record.tags,
      text: record.text,
    });
  } catch {
    /* FAIL-OPEN: a journaling failure must be completely invisible to the caller. */
  }
}

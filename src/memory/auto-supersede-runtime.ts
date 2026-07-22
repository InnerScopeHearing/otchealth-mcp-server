/**
 * AUTO-SUPERSESSION AT WRITE — the I/O layer (Wave 1, W1-2 PART 2).
 *
 * Wires the pure decision core (auto-supersede.ts) into the two memory write paths (memory_write ->
 * Cosmos, memory_remember -> shared feed). Runs BEFORE the write so the decision sets `supersedes`
 * on the NEW entry itself — there is never a post-write mutation of a prior record.
 *
 * SAFETY CONTRACT (this is the memory-of-record; a false positive would retire a TRUE belief):
 *   - FAIL-OPEN + BOUNDED: any error, any missing dependency, or the DETECT_BUDGET_MS timeout returns
 *     {action:'none'} and NEVER throws. The write always proceeds; detection is pure upside.
 *   - The DEFAULT mode is 'suggest' (auto-supersede.ts): detect + emit a reconcile beacon, but do NOT
 *     link supersedes. Only MEMORY_AUTOSUPERSEDE_MODE=auto mutates the retraction graph, and only
 *     'off' skips detection entirely.
 *   - CROSS-AGENT GUARD: the memory-exec `agent` $filter can fail-open to a filter-free query, so we
 *     NEVER trust it alone — every candidate is re-checked against the writer's lane from its docId.
 *   - COST GUARD: the LLM contradiction check fires ONLY after a true-cosine near-duplicate gate, so
 *     the common (unrelated) write pays for a search + one embed, never a chat.
 */
import { loadEnv } from '../config/env.js';
import { embed, chat, type ChatMessage } from '../azure/foundry.js';
import { hybridSearch, type KbHit } from '../azure/search.js';
import { captureGatewayEvent } from '../telemetry/gateway-ops.js';
import { entryIdFromDocId } from './retractions.js';
import {
  autoSupersedeMode,
  cosineSimilarity,
  buildContradictionPrompt,
  parseContradictionVerdict,
  decideSupersession,
  NEAR_DUPLICATE_THRESHOLD,
  SUPERSEDABLE_KINDS,
} from './auto-supersede.js';

/** Hard ceiling on the whole detection so a slow embed/search/LLM can never delay a memory write. */
const DETECT_BUDGET_MS = 4000;
/** How many nearest-prior candidates to consider (relevance-ordered; we take the first that qualifies). */
const CANDIDATE_TOP = 5;
/** The room every memory (both stores) is write-through indexed into — the candidate corpus. */
const MEMORY_INDEX = 'memory-exec';

/** Recover the agent lane from a memory docId `{agent}__{entryId}` (memoryDocId's format). Pure. */
export function agentFromDocId(docId: unknown): string {
  const s = typeof docId === 'string' ? docId : '';
  const i = s.indexOf('__');
  return i >= 0 ? s.slice(0, i) : '';
}

/** Escape a value for use inside an OData string literal. Pure. */
export function odataEscape(s: string): string {
  return (s || '').replace(/'/g, "''");
}

export interface SupersedeOutcome {
  action: 'none' | 'suggest' | 'auto-link';
  /** Entry id to link (auto-link) or surface for reconcile (suggest). */
  supersedeId?: string;
  reason: string;
}

/** Injectable dependencies so the orchestration is unit-testable without real Azure/Foundry. */
export interface SupersedeRuntimeDeps {
  search: typeof hybridSearch;
  embedText: typeof embed;
  chatFn: typeof chat;
  /** Reads MEMORY_AUTOSUPERSEDE_MODE (kept behind a fn so tests set it without touching process.env). */
  mode: () => string | undefined;
  emit: (event: string, properties: Record<string, unknown>) => void;
}

function realDeps(): SupersedeRuntimeDeps {
  return {
    search: hybridSearch,
    embedText: embed,
    chatFn: chat,
    mode: () => {
      try {
        return loadEnv().MEMORY_AUTOSUPERSEDE_MODE;
      } catch {
        return undefined;
      }
    },
    emit: (event, properties) => captureGatewayEvent(event, properties),
  };
}

/**
 * Decide whether the NEW entry supersedes a near-prior same-agent one. FAIL-OPEN + BOUNDED: returns
 * {action:'none'} on any error/timeout and never throws. `vector` is the new entry's ALREADY-computed
 * embedding (reused from the handler's index step, not recomputed here).
 */
export async function detectSupersession(
  input: { agent: string; kind: string; text: string; vector: number[] | null },
  depsOverride?: Partial<SupersedeRuntimeDeps>,
): Promise<SupersedeOutcome> {
  const deps: SupersedeRuntimeDeps = { ...realDeps(), ...depsOverride };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const mode = autoSupersedeMode(deps.mode());
    if (mode === 'off') return { action: 'none', reason: 'mode=off' };
    if (!SUPERSEDABLE_KINDS.has(input.kind)) return { action: 'none', reason: `kind '${input.kind}' not supersedable` };
    if (!input.text || !input.agent) return { action: 'none', reason: 'missing text/agent' };

    const work = detectInner(input, mode, deps);
    const timeout = new Promise<SupersedeOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ action: 'none', reason: 'detection timed out' }), DETECT_BUDGET_MS);
    });
    return await Promise.race([work, timeout]);
  } catch (e) {
    return { action: 'none', reason: `fail-open: ${(e as Error).message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function detectInner(
  input: { agent: string; kind: string; text: string; vector: number[] | null },
  mode: ReturnType<typeof autoSupersedeMode>,
  deps: SupersedeRuntimeDeps,
): Promise<SupersedeOutcome> {
  // 1. Nearest-prior candidates in the writer's own lane, relevance-ordered.
  let res: { matches: KbHit[] } | null = null;
  try {
    res = await deps.search(MEMORY_INDEX, input.text, CANDIDATE_TOP, {
      includeOps: true,
      filter: `agent eq '${odataEscape(input.agent)}'`,
    });
  } catch {
    res = null;
  }
  const hits = res?.matches ?? [];

  // 2. Strongest same-agent, supersedable-kind candidate. The cross-agent re-check is load-bearing:
  //    the server $filter can fail-open to filter-free, so a hit's lane is trusted ONLY from its docId.
  let best: { entryId: string; kind: string; text: string } | null = null;
  for (const h of hits) {
    if (agentFromDocId(h.id) !== input.agent) continue;
    const kind = h.type || '';
    if (!SUPERSEDABLE_KINDS.has(kind)) continue;
    const entryId = entryIdFromDocId(h.id);
    if (!entryId) continue;
    best = { entryId, kind, text: h.text || '' };
    break; // relevance-ordered: the first qualifying hit is the strongest candidate
  }
  if (!best) return { action: 'none', reason: 'no supersedable same-agent candidate' };

  // 3. True-cosine near-duplicate gate BEFORE spending the LLM. Reuse the new vector; embed the
  //    candidate once. A missing vector -> cosine 0 -> below threshold -> skip the chat (fail-safe).
  let candVec: number[] | null = null;
  try {
    candVec = await deps.embedText(best.text);
  } catch {
    candVec = null;
  }
  const similarity = cosineSimilarity(input.vector, candVec);
  if (similarity < NEAR_DUPLICATE_THRESHOLD) {
    return { action: 'none', reason: `nearest similarity ${similarity.toFixed(3)} < ${NEAR_DUPLICATE_THRESHOLD}` };
  }

  // 4. Near-duplicate confirmed -> spend one cheap contradiction check. Tier 'router' -- this is a
  //    bounded classification call (a strict {contradicts, confidence, reason<=140 chars} verdict,
  //    parsed defensively by parseContradictionVerdict which fails safe to contradicts:false on
  //    anything malformed), the exact "cheap classification task" shape the FLEET COST PROTOCOL
  //    means for the Azure Model Router. Model-quality variance here is already absorbed by two
  //    independent gates upstream of any real effect: the near-duplicate cosine gate that ran just
  //    above, and decideSupersession()'s own MIN_CONFIDENCE floor plus its 'suggest'-not-'auto'
  //    default posture (see auto-supersede.ts) -- a weaker verdict degrades to no-op, never a bad
  //    write. When FOUNDRY_ROUTER_ENDPOINT/KEY are unset, chat() degrades this to the same
  //    'standard' deployment used before this change (see foundry.ts).
  const { system, user } = buildContradictionPrompt(input.text, best.text);
  let raw = '';
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const r = await deps.chatFn(messages, { temperature: 0, maxTokens: 120, jsonMode: true, tier: 'router' });
    raw = r.text || '';
  } catch {
    raw = '';
  }
  const verdict = parseContradictionVerdict(raw);

  const decision = decideSupersession({
    mode,
    newKind: input.kind,
    candidate: { id: best.entryId, kind: best.kind, similarity },
    verdict,
  });

  if (decision.action !== 'none') {
    // OBSERVE-ONLY beacon; inert unless POSTHOG_GATEWAYOPS_KEY is set (see gateway-ops.ts). Carries
    // NO memory text — only ids, lane, similarity, confidence — so it never leaks content to telemetry.
    deps.emit(decision.action === 'auto-link' ? 'memory_supersede_linked' : 'memory_supersede_suggested', {
      agent: input.agent,
      new_kind: input.kind,
      superseded_id: decision.supersedeId,
      similarity: Math.round(similarity * 1000) / 1000,
      confidence: verdict.confidence,
      mode,
    });
  }
  return { action: decision.action, supersedeId: decision.supersedeId, reason: decision.reason };
}

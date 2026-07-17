/**
 * AUTO-SUPERSESSION AT WRITE (Wave 1, W1-2) — retire a contradicted belief without agent discipline.
 *
 * ============================ THE PROBLEM THIS EXISTS TO CLOSE ============================
 * `supersedes` is the ONLY mechanism that retires a stale belief (retractions.ts drops any entry id
 * some other entry supersedes, so a retracted belief cannot resurface as a live truth). But it is
 * set by HAND, and only when the writing agent both (a) remembers the older entry exists and (b)
 * remembers to pass supersedes. In practice neither reliably happens: an agent records "X is now Y"
 * without knowing a prior "X is Z" is sitting in the store, so BOTH coexist and recall serves the
 * stale one (the "CORRECTION-plague" — the same class W1-1's re-rank attacks at read time). W1-1
 * fixes RANKING; this fixes the ROOT: detect the contradiction AT WRITE and link supersedes itself.
 *
 * ============================ WHY THE DEFAULT IS 'suggest', NOT 'auto' ============================
 * A false positive here is the ONE failure mode worse than the drift we are fixing: it would silently
 * RETIRE A TRUE BELIEF. So the rollout is measurement-before-enforcement (the plan's own sequencing):
 *   off     -> do nothing (kill-switch).
 *   suggest -> DETECT + FLAG a contradiction (attach a candidate + emit a reconcile beacon) but never
 *              mutate the retraction graph. This is the DEFAULT until the classifier's precision is
 *              proven on the golden-recall suite.
 *   auto    -> additionally link supersedes so the old belief retires with zero agent discipline.
 * Everything in this module is PURE and exhaustively unit-tested so the safety gates are provable
 * without Cosmos or Foundry; the wiring layer (fail-open) does the embedding / vector-query / LLM I/O.
 */

export type AutoSupersedeMode = 'off' | 'suggest' | 'auto';

/**
 * Kill-switch + rollout gate, read from env MEMORY_AUTOSUPERSEDE_MODE. DEFAULT 'suggest': we detect
 * and flag contradictions but do NOT auto-retire until precision is trusted. Only the two explicit
 * strings 'off' and 'auto' move off the safe default; anything else (unset, typo, empty) => 'suggest'.
 */
export function autoSupersedeMode(raw: string | undefined | null): AutoSupersedeMode {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'off' || v === 'auto') return v;
  return 'suggest';
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0 on ANY degenerate input (missing,
 * length mismatch, zero-norm) — never throws, never returns NaN. Pure.
 */
export function cosineSimilarity(
  a: readonly number[] | null | undefined,
  b: readonly number[] | null | undefined,
): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Only entries at least this cosine-similar to the new one are contradiction CANDIDATES. Above this
 * the two entries are "about the same thing" and a contradiction verdict is meaningful; below it a
 * contradiction verdict is untrustworthy (different subjects cannot contradict). Deliberately
 * conservative — on the memory-of-record we want precision, not recall.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.86;

/** Minimum classifier confidence required to act (link or even suggest). Below this: treat as no-op. */
export const MIN_CONFIDENCE = 0.6;

/**
 * Kinds whose truth can be SUPERSEDED by a newer same-subject entry. status/episode are ephemeral
 * (operational exhaust, not durable beliefs); pitfall is cumulative wisdom (a new pitfall does not
 * make an old one false). Only a fact or a decision can make a prior fact/decision FALSE.
 */
export const SUPERSEDABLE_KINDS: ReadonlySet<string> = new Set(['fact', 'decision']);

export interface ContradictionVerdict {
  contradicts: boolean;
  confidence: number; // 0..1
  reason: string;
}

/**
 * Build the (system,user) messages for the cheap contradiction classifier. Pure — the caller runs
 * the LLM. Strict-JSON contract; the model decides ONLY "does NEW make PRIOR false", not merely
 * "are they related / does NEW add detail".
 */
export function buildContradictionPrompt(
  newText: string,
  priorText: string,
): { system: string; user: string } {
  const system = [
    'You compare two company-memory entries and decide whether the NEW entry makes the PRIOR entry FALSE',
    '(so the PRIOR should be retracted and never resurface as a live truth).',
    'CONTRADICTION = the two cannot both be true right now: a changed value, a reversed decision, a corrected fact.',
    'NOT a contradiction: added detail, a related fact, a narrower or broader restatement, or the same fact reworded.',
    'When unsure, answer contradicts:false. Respond with ONLY compact JSON, no prose, no code fence:',
    '{"contradicts":boolean,"confidence":number between 0 and 1,"reason":"<=140 chars"}.',
  ].join(' ');
  const user = `PRIOR:\n${(priorText || '').slice(0, 4000)}\n\nNEW:\n${(newText || '').slice(0, 4000)}`;
  return { system, user };
}

/**
 * Parse the classifier output. FAIL-SAFE: any malformed / missing field => contradicts:false (do
 * nothing). The safe direction for a memory-of-record mutation is always "leave both beliefs live",
 * because W1-1's read-time re-rank is the backstop — silently dropping a true belief has no backstop.
 * Tolerates prose / code fences around the JSON object. Pure.
 */
export function parseContradictionVerdict(raw: string | null | undefined): ContradictionVerdict {
  const safe: ContradictionVerdict = { contradicts: false, confidence: 0, reason: 'unparseable' };
  if (!raw || typeof raw !== 'string') return safe;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return safe;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    if (typeof o.contradicts !== 'boolean') return safe;
    const confidence =
      typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : 0;
    const reason = typeof o.reason === 'string' ? o.reason.slice(0, 140) : '';
    return { contradicts: o.contradicts, confidence, reason };
  } catch {
    return safe;
  }
}

export interface SupersedeCandidate {
  /** prior entry id (the one that would be retired) */
  id: string;
  /** prior entry kind */
  kind: string;
  /** cosine similarity of the prior entry to the NEW entry */
  similarity: number;
}

export interface SupersedeDecision {
  action: 'none' | 'suggest' | 'auto-link';
  supersedeId?: string;
  reason: string;
}

/**
 * THE pure decision. Given the mode, the best near-prior candidate, and the classifier verdict,
 * decide whether to auto-link supersedes, merely suggest it, or do nothing. EVERY safety gate lives
 * here so it is exhaustively unit-testable without Cosmos/Foundry. Order matters: cheap structural
 * gates (mode, kinds, similarity) are checked before trusting the classifier verdict.
 */
export function decideSupersession(args: {
  mode: AutoSupersedeMode;
  newKind: string;
  candidate: SupersedeCandidate | null;
  verdict: ContradictionVerdict;
}): SupersedeDecision {
  const { mode, newKind, candidate, verdict } = args;
  if (mode === 'off') return { action: 'none', reason: 'mode=off' };
  if (!candidate) return { action: 'none', reason: 'no near-prior candidate' };
  if (!SUPERSEDABLE_KINDS.has(newKind)) {
    return { action: 'none', reason: `new kind '${newKind}' cannot supersede a prior belief` };
  }
  if (!SUPERSEDABLE_KINDS.has(candidate.kind)) {
    return { action: 'none', reason: `prior kind '${candidate.kind}' is not supersedable` };
  }
  if (candidate.similarity < NEAR_DUPLICATE_THRESHOLD) {
    return {
      action: 'none',
      reason: `similarity ${candidate.similarity.toFixed(3)} < ${NEAR_DUPLICATE_THRESHOLD} (different subject)`,
    };
  }
  if (!verdict.contradicts) return { action: 'none', reason: 'classifier: no contradiction' };
  if (verdict.confidence < MIN_CONFIDENCE) {
    return { action: 'none', reason: `confidence ${verdict.confidence.toFixed(2)} < ${MIN_CONFIDENCE}` };
  }
  // Confident contradiction, same subject, both kinds supersedable.
  if (mode === 'auto') {
    return { action: 'auto-link', supersedeId: candidate.id, reason: `auto-linked: ${verdict.reason}` };
  }
  return { action: 'suggest', supersedeId: candidate.id, reason: `suggested: ${verdict.reason}` };
}

/**
 * Pick the single strongest candidate from the nearest-prior set: highest similarity, EXCLUDING the
 * just-written entry itself (self-match) and any entry the new one could not sensibly retire. Pure.
 * The wiring passes the vector-search neighbours here; decideSupersession() applies the real gates.
 */
export function bestCandidate(
  selfId: string,
  neighbours: readonly SupersedeCandidate[] | null | undefined,
): SupersedeCandidate | null {
  if (!neighbours || neighbours.length === 0) return null;
  let best: SupersedeCandidate | null = null;
  for (const n of neighbours) {
    if (!n || !n.id || n.id === selfId) continue;
    if (best === null || n.similarity > best.similarity) best = n;
  }
  return best;
}

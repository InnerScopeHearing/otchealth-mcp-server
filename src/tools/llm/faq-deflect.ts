/**
 * FAQ / intent deflection is an embedding-backed pre-step in front of llm_azure. When enabled,
 * it embeds eligible questions and compares them with curated Q&A entries. A hit returns the
 * reviewed answer without a chat-completion call; the embedding request and vector lookup still
 * consume provider and storage resources.
 *
 * STORE CHOICE: reuse the existing Cosmos DB `cache` container and gateway embedding adapter
 * under a separate `faq:` partition. This avoids adding a new service or credential, but it is
 * not cost-free: each eligible FAQ check may incur embedding/API and database charges.
 *
 * Curated answers are static, reviewed text rather than model-generated content. A high threshold
 * limits false matches, and failures fall through to the normal chat-completion path.
 *
 * SEEDING: seedFaqStore() upserts FAQ_SEED (a short, intentionally generic set of real fleet
 * facts — build/release info and common cross-functional questions) into the cache container on
 * first use when FAQ_DEFLECT_MODE=on and the store looks empty for a given entry id. No PHI, no
 * MedReview content, no sensitive internal figures — those never belong in a canned-answer store
 * that skips guardrail review of freshly generated text.
 *
 * MODE-GATED + FAIL-OPEN (same shape as LLM_CACHE_MODE / SHIELD_MODE / GROUNDEDNESS_MODE):
 *   FAQ_DEFLECT_MODE: off (default) | on
 *     off -> never touched; llm_azure behaves exactly as before this module existed.
 *     on  -> before the semantic cache and chat-completion call, check the FAQ store for
 *            high-confidence matches on task='complete' inputs (the "ask a question" shape;
 *            summarize/classify/extract/synthesize are not FAQ-shaped and are never deflected).
 *            The lookup may call the embedding model. On ANY failure (Cosmos down, embedding
 *            error, malformed doc) it falls through to the normal cache/chat-completion path.
 *            A deflection dependency must never take a real answer down.
 *   FAQ_DEFLECT_SIMILARITY_THRESHOLD: cosine similarity floor for a deflection hit (default 0.93;
 *     intentionally looser than the semantic cache's near-duplicate bar (0.95) because FAQ intents
 *     are matched by MEANING ("how do I request PTO" ~= "who do I ask for time off"), not
 *     near-identical prior prompts, but still conservative enough that unrelated questions fall
 *     through to the normal completion path rather than getting the wrong canned answer.
 */

import { isConfigured, upsertDoc, vectorSearchDocs, newId, type VectorMatch } from '../../agentstate/store.js';
import { embed as gatewayEmbed } from '../../azure/foundry.js';

const FAQ_CONTAINER = 'cache';
const VECTOR_FIELD = 'queryVector';
const FAQ_SCOPE = 'faq:global';
/** FAQ entries are curated reference facts, not ephemeral cache — a long TTL (30 days) is fine. */
const FAQ_TTL_SECONDS = 2592000;

export const DEFAULT_SIMILARITY_THRESHOLD = 0.93;

export type FaqDeflectModeValue = 'off' | 'on';

/** Read FAQ_DEFLECT_MODE fresh from process.env, like LLM_CACHE_MODE. Defaults to 'off'. */
export function faqDeflectMode(): FaqDeflectModeValue {
  return (process.env.FAQ_DEFLECT_MODE || '').trim().toLowerCase() === 'on' ? 'on' : 'off';
}

/** Read FAQ_DEFLECT_SIMILARITY_THRESHOLD fresh from process.env, clamped to a sane (0,1] range. */
export function similarityThreshold(): number {
  const raw = Number(process.env.FAQ_DEFLECT_SIMILARITY_THRESHOLD);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return DEFAULT_SIMILARITY_THRESHOLD;
  return raw;
}

/**
 * A small, intentionally generic seed set: build/release facts and common cross-functional
 * questions any fleet agent might ask repeatedly. No sensitive figures, no PHI, no MedReview
 * content — these are exactly the kind of low-stakes, high-repeat questions App Template #41's
 * CQA layer targets, just answered from a curated static store instead of a live QA project.
 */
export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
}

export const FAQ_SEED: FaqEntry[] = [
  {
    id: 'faq-runtime',
    question: 'What Node.js version does the gateway run on?',
    answer: 'The otchealth-mcp-server gateway targets Node 22 (engines >=20 declared in package.json). Tests run via `node --test --import tsx`.',
  },
  {
    id: 'faq-test-command',
    question: 'How do I run the gateway test suite?',
    answer: 'From the repo root: `npm ci` then `npm run typecheck` and `npm test` (node:test via tsx, pattern `src/**/*.test.ts`).',
  },
  {
    id: 'faq-model-router',
    question: 'How does the gateway pick which LLM model to use?',
    answer: 'llm_azure is a legacy tool name and uses OpenAI-direct when configured. Default tiers are standard=gpt-5.6-terra, high=gpt-5.6-sol, and router=gpt-5.6-luna; gateway settings may override them. The router is not Azure Model Router. Keep model selection tied to the approved quality and cost checks.',
  },
  {
    id: 'faq-read-only-mode',
    question: 'Why are write tools disabled / how do I enable write tools on the gateway?',
    answer: 'Write tools are gated by READ_ONLY_MODE and ENABLE_WRITE_TOOLS. Set READ_ONLY_MODE=false and ENABLE_WRITE_TOOLS=true to enable write_simple tools; write_orchestrated (high-risk) tools additionally require ENABLE_HIGH_RISK_TOOLS=true and, by default, a cto caller-agent identity.',
  },
  {
    id: 'faq-pii-phi-policy',
    question: 'Can I send PHI or medical review content through the gateway LLM tools?',
    answer: 'No. PHI and MedReview content must never be sent through llm_azure or other consumer gateway LLM tools. Keep it inside the authorized BAA-covered environment and out of prompts, embeddings, and caches in this gateway.',
  },
  {
    id: 'faq-deploy-policy',
    question: 'How are changes deployed to the gateway / can an agent deploy to production?',
    answer: 'Changes land via PR to main with CI green (typecheck + test); merges and production deploys are a human/CTO-gated action, never an automatic side effect of an agent PR.',
  },
];

export interface FaqDeflectDeps {
  isCosmosConfigured: () => boolean;
  embed: (text: string) => Promise<number[] | null>;
  vectorSearch: (
    coll: string,
    pkValue: string,
    vectorField: string,
    vector: number[],
    top?: number,
  ) => Promise<VectorMatch[]>;
  upsert: (coll: string, pkValue: string, doc: Record<string, unknown>) => Promise<unknown>;
}

const defaultDeps: FaqDeflectDeps = {
  isCosmosConfigured: isConfigured,
  embed: gatewayEmbed,
  vectorSearch: vectorSearchDocs,
  upsert: upsertDoc,
};

interface FaqDoc {
  id: string;
  cacheScope: string;
  question: string;
  queryVector: number[];
  answer: string;
  faqId: string;
  ts: string;
  ttl: number;
}

/** Is the FAQ deflection layer eligible to run at all for this (mode, task, cosmos) combination? */
export function faqEligible(
  task: string,
  deps: Pick<FaqDeflectDeps, 'isCosmosConfigured'> = defaultDeps,
): boolean {
  if (faqDeflectMode() !== 'on') return false;
  // Only "ask a question" shaped calls are FAQ-shaped. summarize/classify/extract/synthesize
  // operate over caller-supplied content, not a canonical question, so they are never deflected.
  if (task !== 'complete') return false;
  return deps.isCosmosConfigured();
}

export interface FaqDeflectResult {
  hit: boolean;
  answer?: string;
  faqId?: string;
  similarity?: number;
}

/**
 * Check the curated FAQ store before the semantic response cache and chat-completion call.
 * The lookup may call embeddings. Returns hit:false on any failure (fail-open) so the caller
 * falls through to the existing llm_azure path. Never throws.
 */
export async function checkFaqDeflect(
  question: string,
  task: string,
  opts?: { threshold?: number; deps?: Partial<FaqDeflectDeps> },
): Promise<FaqDeflectResult> {
  const deps: FaqDeflectDeps = { ...defaultDeps, ...opts?.deps };
  if (!faqEligible(task, deps)) return { hit: false };
  const threshold = opts?.threshold ?? similarityThreshold();
  try {
    const vector = await deps.embed(question);
    if (!vector) return { hit: false };
    const matches = await deps.vectorSearch(FAQ_CONTAINER, FAQ_SCOPE, VECTOR_FIELD, vector, 1);
    const top = matches[0];
    if (!top || top.similarity < threshold) return { hit: false };
    const doc = top.doc as unknown as FaqDoc;
    if (!doc || typeof doc.answer !== 'string' || !doc.answer) return { hit: false };
    return { hit: true, answer: doc.answer, faqId: doc.faqId, similarity: top.similarity };
  } catch {
    return { hit: false }; // fail-open: any embedding or storage error just means "no FAQ hit"
  }
}

/**
 * Best-effort seed of FAQ_SEED into the store. Idempotent (upsertDoc keyed by deterministic id),
 * safe to call on every eligible request — it is a cheap no-op once the entries already exist
 * with a live vector, and it lets the store self-heal after a Cosmos container recreation without
 * a separate deploy step. Never throws; failures are swallowed exactly like a cache write.
 */
export async function seedFaqStore(opts?: { deps?: Partial<FaqDeflectDeps> }): Promise<void> {
  const deps: FaqDeflectDeps = { ...defaultDeps, ...opts?.deps };
  if (!deps.isCosmosConfigured()) return;
  for (const entry of FAQ_SEED) {
    try {
      const vector = await deps.embed(entry.question);
      if (!vector) continue;
      const doc: FaqDoc = {
        id: `faqseed-${entry.id}`,
        cacheScope: FAQ_SCOPE,
        question: entry.question,
        queryVector: vector,
        answer: entry.answer,
        faqId: entry.id,
        ts: new Date().toISOString(),
        ttl: FAQ_TTL_SECONDS,
      };
      await deps.upsert(FAQ_CONTAINER, FAQ_SCOPE, doc as unknown as Record<string, unknown>);
    } catch {
      /* best-effort seed; one bad entry must never block the others or the caller */
    }
  }
}

/** Exposed for tests / operational tooling that wants a fresh deterministic id without seeding. */
export function faqDocId(faqId: string): string {
  return newId(`faq-${faqId}`);
}

/** True when the deflection layer is switched on at all (independent of task/eligibility). */
export function faqDeflectOn(): boolean {
  return faqDeflectMode() === 'on';
}

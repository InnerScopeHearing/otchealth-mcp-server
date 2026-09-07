/**
 * DETERMINISTIC CURRENT-VALUE LOOKUP (Wave 1, W1-3) — answer "what is X now?" structurally, not by
 * semantic luck.
 *
 * ============================ THE GAP THIS CLOSES ============================
 * The typed ENTITY / current-value layer was built in Wave 3 (skills/kb-memory/mem.mjs: `mem.mjs
 * entity set <key> <value>` writes a row of type "entity" with {ekey, evalue}, latest-per-key wins,
 * history retained via supersedes; an "alias" row points many phrasings at one canonical key). Those
 * rows ride the SAME commons feed + semantic index as every other entry — so brain_search already
 * RETURNS them, but only RANKED SEMANTICALLY. For a lookup-class question ("what is the ASC signing
 * key id", "n8n base url") that means the current value competes on reranker score with stale/related
 * chatter and can land below a superseded mention. The entity layer existed but was never wired into
 * the recall path as an exact-key promotion. This does that: a query that resolves to a known entity
 * key gets that key's CURRENT value surfaced deterministically, ahead of the semantic top-k.
 *
 * RING-SAFE BY CONSTRUCTION: the source is the commons feed (store.ts readSharedAll), which is
 * hardwired to otchealthcommons/company-journal and has NO credentials for the cfo (MNPI) /
 * clo-personal / PHI stores. Entity rows are already write-through indexed into memory-exec (an
 * OPEN_ROOM every lane searches), so promoting one exposes nothing a semantic query could not already
 * surface — this changes RANKING, never the exposure boundary.
 *
 * The matching + selection are PURE (exhaustively testable without Azure); the loader is a small
 * TTL-cached, FAIL-OPEN read over the commons feed (an outage returns "no entity", never an error).
 */
import { readSharedAll } from './store.js';
import { collectRetractedByAgent } from './retractions.js';

/** A ledger row carrying the typed-entity fields. MemoryEntry's `type` union predates entity/alias,
 *  so those rows arrive as plain objects with a widened `type`; model that explicitly here. */
export interface EntityRow {
  id?: string;
  ts?: string;
  type?: string;
  ekey?: string;
  evalue?: string;
  source?: string;
  tags?: string[] | string;
  agent?: string;
  by?: string;
  supersedes?: string;
}

export interface EntityHit {
  ekey: string;
  evalue: string;
  ts: string;
  id: string;
  source?: string;
  owner?: string;
  matchedBy?: 'exact' | 'containment' | 'current-question';
}

/**
 * Collapse casing/punctuation to a canonical key token-string. IDENTICAL to mem.mjs's normKey so the
 * gateway and the skill resolve the exact same key from the exact same phrasing. Pure.
 * "iHEARtest Build" -> "iheartest_build"; "  n8n base URL " -> "n8n_base_url".
 */
export function normKey(s: unknown): string {
  return (typeof s === 'string' ? s : '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Follow the alias chain (type "alias", ekey->evalue) to a canonical key, bounded to 8 hops with a
 *  seen-set so a cycle can never loop forever. Mirrors mem.mjs resolveAlias. Pure. */
export function resolveAlias(rows: readonly EntityRow[], key: string): string {
  let k = normKey(key);
  const seen = new Set<string>();
  for (let i = 0; i < 8 && !seen.has(k); i++) {
    seen.add(k);
    const a = rows
      .filter((r) => r.type === 'alias' && r.ekey === k)
      .sort((x, y) => (y.ts || '').localeCompare(x.ts || ''))[0];
    if (!a || !a.evalue || a.evalue === k) break;
    k = a.evalue;
  }
  return k;
}

/** The current (latest-ts) entity row for a canonical key, or null. Mirrors mem.mjs currentEntity. Pure. */
export function currentEntity(rows: readonly EntityRow[], k: string): EntityRow | null {
  return (
    rows
      .filter((r) => r.type === 'entity' && r.ekey === k)
      .sort((x, y) => (y.ts || '').localeCompare(x.ts || ''))[0] || null
  );
}

/** Shortest key length (in normalized chars) that may match by containment. Below this, a key is too
 *  generic to trust as a whole-query substring (avoids "id"/"key" firing on any sentence). */
export const MIN_KEY_LEN = 4;

/** Alias contract for current-only natural-language phrases. These aliases resolve when the whole
 * query matches, but never become containment candidates inside a longer historical question. */
export const EXACT_MATCH_ONLY_TAG = 'exact-match-only';

function hasTag(row: EntityRow, tag: string): boolean {
  const tags = Array.isArray(row.tags) ? row.tags : String(row.tags || '').split(',');
  return tags.some((value) => value.trim().toLowerCase() === tag);
}

/** Rows that make up the bounded, typed current-state schema are explicitly tagged at write time. */
export const CURRENT_VALUE_TAG = 'current-value';

const CURRENT_INTENT = new Set(['current', 'currently', 'now', 'today', 'active', 'live', 'present', 'presently', 'still']);
const HISTORICAL_INTENT = new Set([
  'historical', 'historically', 'former', 'formerly', 'previous', 'previously', 'prior', 'past',
  'legacy', 'old', 'before', 'replaced', 'replace', 'migration', 'migrated', 'was', 'were', 'did',
  'ago',
]);
const COMPANY_SCOPE = new Set(['otchealth', 'innerscope', 'innd', 'our', 'company']);
const STRONG_SUBSYSTEM_SCOPE = new Set([
  'brain', 'gateway', 'mcp', 'agent', 'agents', 'checkpoint', 'checkpoints', 'handoff', 'handoffs',
]);

/**
 * Small vocabulary clusters, not query aliases. Canonical entity keys select clusters by their own
 * tokens, then an unseen query must independently match the key's distinctive domain cluster and
 * enough of its remaining concepts. This lets new phrasings compose without storing every sentence.
 */
const CONCEPTS: ReadonlyArray<{ anchor: string; words: ReadonlySet<string>; domain?: boolean }> = [
  { anchor: 'cloud', domain: true, words: new Set(['cloud', 'estate', 'hosting', 'host', 'hosts', 'hosted', 'provider', 'platform', 'infrastructure']) },
  { anchor: 'gateway', domain: true, words: new Set(['gateway', 'mcp', 'api']) },
  { anchor: 'brain', domain: true, words: new Set(['brain', 'memory', 'memories', 'knowledge', 'search', 'index', 'indexes', 'indexing']) },
  { anchor: 'agent', domain: true, words: new Set(['agent', 'agents', 'checkpoint', 'checkpoints', 'handoff', 'handoffs', 'session', 'sessions']) },
  { anchor: 'state', words: new Set(['state', 'states', 'checkpoint', 'checkpoints', 'handoff', 'handoffs', 'session', 'sessions', 'coordination']) },
  { anchor: 'backend', words: new Set(['backend', 'store', 'stores', 'storage', 'database', 'engine', 'service', 'system', 'keep', 'keeps', 'kept', 'persist', 'persists', 'power', 'powers', 'powered']) },
  { anchor: 'runtime', words: new Set(['runtime', 'run', 'runs', 'running', 'host', 'hosts', 'hosted', 'container', 'deployment', 'deployed']) },
];

function tokenSet(value: string): Set<string> {
  return new Set(normKey(value).split('_').filter(Boolean));
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function hasHistoricalIntent(tokens: ReadonlySet<string>): boolean {
  return intersects(tokens, HISTORICAL_INTENT) || (tokens.has('used') && tokens.has('to'));
}

/**
 * Infer one CTO-owned infrastructure entity from a present-tense current-state question. Pure.
 * Precision gates are deliberate: explicit current intent, no historical intent, company or strong
 * subsystem scope, current-value tag, owner=cto, provenance, a distinctive domain match, and one
 * unambiguous best candidate. Exact keys/aliases continue to use the compatibility path above.
 */
export function matchCurrentQuestion(query: string, rows: readonly EntityRow[]): EntityHit | null {
  const queryTokens = tokenSet(query);
  if (!intersects(queryTokens, CURRENT_INTENT) || hasHistoricalIntent(queryTokens)) return null;

  const queryHasCompanyScope = intersects(queryTokens, COMPANY_SCOPE);
  if (!queryHasCompanyScope && !intersects(queryTokens, STRONG_SUBSYSTEM_SCOPE)) return null;
  const scored: Array<{ row: EntityRow; matched: number; total: number }> = [];
  const keys = new Set(rows.filter((row) => row.type === 'entity' && row.ekey).map((row) => row.ekey as string));

  for (const key of keys) {
    const row = currentEntity(rows, key);
    if (
      !row ||
      typeof row.evalue !== 'string' ||
      row.agent !== 'cto' ||
      !row.source ||
      !hasTag(row, CURRENT_VALUE_TAG)
    ) continue;

    const keyTokens = tokenSet(key);
    if (!keyTokens.has('otchealth')) continue;
    const concepts = CONCEPTS.filter((concept) => keyTokens.has(concept.anchor));
    const domainConcepts = concepts.filter((concept) => concept.domain);
    if (domainConcepts.length === 0) continue;

    const matchedConcepts = concepts.filter((concept) => intersects(queryTokens, concept.words));
    const matchedDomains = domainConcepts.filter((concept) => intersects(queryTokens, concept.words));
    if (matchedDomains.length === 0) continue;

    // A one-concept key such as primary_cloud is specific once company/current gates pass.
    // Multi-concept keys must match at least two clusters, preventing "current backend" guessing.
    const required = Math.min(2, concepts.length);
    if (matchedConcepts.length < required) continue;
    scored.push({ row, matched: matchedConcepts.length, total: concepts.length });
  }

  scored.sort((a, b) =>
    (b.matched / b.total) - (a.matched / a.total) ||
    b.matched - a.matched ||
    String(b.row.ekey).length - String(a.row.ekey).length,
  );
  if (scored.length === 0) return null;
  if (scored.length > 1) {
    const first = scored[0];
    const second = scored[1];
    if (first.matched * second.total === second.matched * first.total && first.matched === second.matched) return null;
  }

  const row = scored[0].row;
  return {
    ekey: row.ekey as string,
    evalue: row.evalue as string,
    ts: row.ts || '',
    id: row.id || '',
    source: row.source,
    owner: row.agent,
    matchedBy: 'current-question',
  };
}

/** Drop typed rows retracted by a later entry in the same agent lane. Pure and collision-safe. */
export function activeEntityRows(rows: readonly EntityRow[]): EntityRow[] {
  const retracted = collectRetractedByAgent([...rows]);
  return rows.filter((row) => {
    if (row.type !== 'entity' && row.type !== 'alias') return false;
    const owner = typeof row.agent === 'string' ? row.agent : '';
    const id = typeof row.id === 'string' ? row.id : '';
    return !(owner && id && retracted.get(owner)?.has(id));
  });
}

/**
 * Resolve a natural-language query to the single best current-value entity, or null. PURE.
 *
 * Precision-first (a wrong deterministic answer is worse than none):
 *  1) EXACT: normKey(query) is itself a known entity key, or an alias to one.
 *  2) CONTAINMENT: a known entity key (or alias key) appears as a token-bounded substring of the
 *     normalized query — e.g. "what is the n8n base url now" contains "n8n_base_url". Among all
 *     matches the LONGEST (most specific) key wins; ties break toward a direct entity over an alias.
 * Only keys of length >= MIN_KEY_LEN are containment candidates. Returns the CURRENT value for the
 * resolved key (latest-ts), so it is structurally unable to return a superseded value.
 */
export function matchEntity(query: string, rows: readonly EntityRow[]): EntityHit | null {
  const nq = normKey(query);
  if (!nq) return null;

  const toHit = (row: EntityRow | null, matchedBy: EntityHit['matchedBy']): EntityHit | null =>
    row && row.ekey && typeof row.evalue === 'string'
      ? {
          ekey: row.ekey, evalue: row.evalue, ts: row.ts || '', id: row.id || '',
          source: row.source, owner: row.agent, matchedBy,
        }
      : null;

  // 1) EXACT: the whole query normalizes to a key (or an alias to one).
  const exactKey = resolveAlias(rows, nq);
  const exact = toHit(currentEntity(rows, exactKey), 'exact');
  if (exact) return exact;

  // Historical questions must stay semantic. Do not promote a current row merely because the
  // sentence embeds its canonical key (exact whole-key requests above remain supported).
  if (hasHistoricalIntent(tokenSet(query))) return null;

  // 2) CONTAINMENT: the longest known key that appears token-bounded inside the query.
  const padded = `_${nq}_`;
  const entityKeys = new Set<string>();
  const latestAliases = new Map<string, EntityRow>();
  for (const r of rows) {
    if (r.type === 'entity' && r.ekey) {
      entityKeys.add(r.ekey);
    } else if (r.type === 'alias' && r.ekey) {
      const previous = latestAliases.get(r.ekey);
      if (!previous || (r.ts || '').localeCompare(previous.ts || '') > 0) latestAliases.set(r.ekey, r);
    }
  }
  // Exact-only is evaluated on the latest row for each alias. An older untagged row cannot keep
  // containment enabled after the owner corrects that alias to the safer tagged contract.
  const aliasKeys = new Set(
    [...latestAliases.entries()]
      .filter(([, row]) => !hasTag(row, EXACT_MATCH_ONLY_TAG))
      .map(([key]) => key),
  );

  let best: { key: string; isEntity: boolean } | null = null;
  const consider = (key: string, isEntity: boolean) => {
    if (key.length < MIN_KEY_LEN) return;
    if (!padded.includes(`_${key}_`)) return;
    if (
      !best ||
      key.length > best.key.length ||
      // tie on length: prefer a direct entity key over an alias key (fewer indirections)
      (key.length === best.key.length && isEntity && !best.isEntity)
    ) {
      best = { key, isEntity };
    }
  };
  for (const k of entityKeys) consider(k, true);
  for (const k of aliasKeys) consider(k, false);

  if (!best) return matchCurrentQuestion(query, rows);
  const resolved = (best as { key: string; isEntity: boolean }).isEntity
    ? (best as { key: string }).key
    : resolveAlias(rows, (best as { key: string }).key);
  return toHit(currentEntity(rows, resolved), 'containment');
}

// ── cached, fail-open loader ──────────────────────────────────────────────────────────────────────
const TTL_MS = 120_000;
let cache: { at: number; rows: EntityRow[] } | null = null;

/** The entity + alias rows from the commons feed, briefly cached. FAIL-OPEN: any error -> [] (so the
 *  caller degrades to pure semantic recall, never an outage). Exported for the test seam reset. */
export async function entityRows(nowMs: number = Date.now()): Promise<EntityRow[]> {
  if (cache && nowMs - cache.at < TTL_MS) return cache.rows;
  let rows: EntityRow[] = [];
  try {
    // readSharedAll() types rows as MemoryEntry (whose `type` union predates entity/alias); the raw
    // JSONL really carries entity/alias rows, so re-view as EntityRow to read ekey/evalue/wider type.
    const all = (await readSharedAll()) as unknown as EntityRow[];
    rows = activeEntityRows(all);
  } catch {
    rows = []; // fail-open
  }
  cache = { at: nowMs, rows };
  return rows;
}

/** Test seam: drop the cache so one test never sees another's rows. */
export function __resetEntityCache(): void {
  cache = null;
}

/**
 * The recall-path entry point: resolve a query to its current-value entity, or null. FAIL-OPEN and
 * kill-switchable — pass mode 'off' (from ENTITY_LOOKUP_MODE) to disable entirely. Never throws.
 */
export async function lookupEntity(query: string, mode?: string): Promise<EntityHit | null> {
  if ((mode || '').trim().toLowerCase() === 'off') return null;
  try {
    const rows = await entityRows();
    return matchEntity(query, rows);
  } catch {
    return null;
  }
}


/**
 * Structured memory-of-record on Cosmos DB (the `memory` container, partitioned on /agent).
 *
 * This is the deterministic, byte-exact, queryable memory store: facts, decisions, corrections,
 * pitfalls, status. It complements (does not replace) the append-only kb-memory commons feed and
 * the AI Search "company-brain" semantic index. Verbatim-critical records live HERE (Cosmos),
 * never in an LLM-consolidated store that could rewrite them.
 *
 * Recall here is deterministic keyword/field filtering. Semantic recall stays in company-brain.
 */

import { createDoc, readDoc, queryDocs, newId } from './cosmos.js';
import { normalizeAgent, type MemoryKind } from './agents.js';

const MEMORY = 'memory';

export interface MemoryRecord {
  id: string;
  type: 'memory';
  agent: string;
  kind: MemoryKind;
  text: string;
  tags: string[];
  source: string | null;
  /** id of a record this one REPLACES (correction chain). See MemoryEntry.supersedes. */
  supersedes?: string | null;
  created_at: string;
}

export async function writeMemory(input: {
  agent: string;
  kind: MemoryKind;
  text: string;
  tags?: string[];
  source?: string;
  supersedes?: string;
}): Promise<MemoryRecord> {
  const agent = normalizeAgent(input.agent);
  const rec: MemoryRecord = {
    id: newId('m'),
    type: 'memory',
    agent,
    kind: input.kind,
    text: input.text,
    tags: input.tags ?? [],
    source: input.source ?? null,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    created_at: new Date().toISOString(),
  };
  await createDoc(MEMORY, agent, rec as unknown as Record<string, unknown>);
  return rec;
}

export async function getMemory(id: string, agent: string): Promise<MemoryRecord | null> {
  const hit = await readDoc(MEMORY, normalizeAgent(agent), id);
  return hit ? (hit.doc as unknown as MemoryRecord) : null;
}

export async function searchMemory(filter: {
  agent?: string;
  kind?: MemoryKind;
  contains?: string;
  limit?: number;
}): Promise<MemoryRecord[]> {
  const conds: string[] = ["c.type = 'memory'"];
  const params: { name: string; value: unknown }[] = [];
  let pk: string | undefined;
  if (filter.agent) {
    const a = normalizeAgent(filter.agent);
    conds.push('c.agent = @agent');
    params.push({ name: '@agent', value: a });
    pk = a;
  }
  if (filter.kind) {
    conds.push('c.kind = @kind');
    params.push({ name: '@kind', value: filter.kind });
  }
  if (filter.contains) {
    conds.push('CONTAINS(LOWER(c.text), @q)');
    params.push({ name: '@q', value: filter.contains.toLowerCase() });
  }
  const query = `SELECT * FROM c WHERE ${conds.join(' AND ')} ORDER BY c.created_at DESC`;
  const rows = await queryDocs(MEMORY, query, params, { pk, max: filter.limit ?? 25 });
  return rows as unknown as MemoryRecord[];
}

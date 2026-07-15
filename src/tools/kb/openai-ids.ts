/**
 * Composite id scheme for the OpenAI ChatGPT / Deep Research connector's `search` + `fetch` tool
 * pair (see openai-search.ts / openai-fetch.ts). Pure parsing/building only — no ring logic lives
 * here (see the SECURITY note below).
 *
 * The OpenAI MCP contract has `search` return an opaque `id` per result, then later calls
 * `fetch(id)` to resolve it to full text. This gateway federates search across multiple Azure AI
 * Search ROOMS (kb/brain-search.ts's roomsFor), so the id has to carry BOTH which room a hit came
 * from AND that room's own document key — fetch cannot re-run a keyless global lookup, and it must
 * not have to trust a side channel to know which room to even ask.
 *
 * FORMAT: `${room}::${docKey}`. Room names are a small, fixed, code-controlled vocabulary (see
 * OPEN_ROOMS / RING_ROOMS in kb/brain-search.ts) that never itself contains "::", so splitting on
 * the FIRST "::" occurrence unambiguously separates room from key even when the key itself contains
 * "::" (e.g. a path-shaped doc key). Room names are also never empty, so a well-formed id always has
 * a non-empty room before the separator.
 *
 * ============================ SECURITY ============================
 * This module answers "what room and key does this id name", never "is this caller allowed to read
 * that room". Treat every id parseCompositeId() returns as UNTRUSTED input describing an ASK, not a
 * GRANT — it may be self-constructed, replayed from another caller's output, or guessed from a known
 * doc path. The actual ring check lives in openai-fetch.ts's handler, which re-derives the room from
 * the id and re-checks it against roomsFor(caller) BEFORE ever touching Azure Search. See that
 * file's header for the load-bearing property.
 */

const SEPARATOR = '::';

export interface CompositeId {
  room: string;
  key: string;
}

/** Build the opaque composite id `search` hands back for a hit in `room` with document key `key`. Pure. */
export function buildCompositeId(room: string, key: string): string {
  return `${room}${SEPARATOR}${key}`;
}

/**
 * Parse a composite id back into { room, key }. Returns null for anything that does not look like a
 * well-formed composite id (no separator, empty room, empty key after trimming) — callers MUST treat
 * null as fail-closed (refuse), never guess a default room. Pure; never throws.
 */
export function parseCompositeId(id: unknown): CompositeId | null {
  if (typeof id !== 'string') return null;
  const sep = id.indexOf(SEPARATOR);
  if (sep <= 0) return null;
  const room = id.slice(0, sep);
  const key = id.slice(sep + SEPARATOR.length);
  if (!room.trim() || !key.trim()) return null;
  return { room, key };
}

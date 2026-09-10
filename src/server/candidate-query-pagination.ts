export const MAX_DISCOVERED_CANDIDATES = 256 * 400;

export function validCandidatePagination(query: Record<string, unknown>): boolean {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 100;
  return Number.isSafeInteger(offset) && (offset as number) >= 0 &&
    (offset as number) <= MAX_DISCOVERED_CANDIDATES &&
    Number.isSafeInteger(limit) && (limit as number) >= 1 && (limit as number) <= 100;
}

/** Drain a single bounded resolver history before applying the global result offset. */
export async function collectHistoryCandidates<T>(read: (offset: number) => Promise<{
  items: T[]; total: number; next_offset: number | null;
}>): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  let expectedTotal: number | undefined;
  for (let page = 0; page < 4; page++) {
    const result = await read(offset);
    if (!Number.isSafeInteger(result.total) || result.total < 0 || result.total > 400 ||
        !Array.isArray(result.items) || result.items.length > 100 ||
        (expectedTotal !== undefined && result.total !== expectedTotal)) {
      throw new Error('candidate_pagination_inconsistent');
    }
    expectedTotal = result.total;
    items.push(...result.items);
    const next = offset + result.items.length;
    if (result.next_offset === null) {
      if (next !== result.total) throw new Error('candidate_pagination_inconsistent');
      return items;
    }
    if (result.items.length === 0 || result.next_offset !== next || next >= result.total) {
      throw new Error('candidate_pagination_inconsistent');
    }
    offset = next;
  }
  throw new Error('candidate_pagination_inconsistent');
}

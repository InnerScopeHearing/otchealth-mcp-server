import { queryDocs } from './store.js';
import { MEMORY_KINDS, type MemoryKind } from './agents.js';

// This rollout endpoint deliberately has no cross-role or privileged-personal mode.
const COMPANY_LANES = new Set(['cto', 'developer', 'coo', 'cro', 'cfo', 'clo', 'wefunder-campaign-director']);
const ID_RE = /^[A-Za-z0-9_.\-]{1,255}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && ID_RE.test(value) && !/^\.+$/.test(value);
const lane = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

interface InventoryCursor { v: 1; owner: string; after: string; started_at: string }
interface MemoryMetadata {
  id: string;
  agent: string;
  kind: MemoryKind | null;
  created_at: string | null;
  metadata_valid: boolean;
}
export interface MemoryInventoryPage {
  inventory: true;
  count: number;
  records: MemoryMetadata[];
  status: 'success' | 'denied';
  lookup_performed: boolean;
  blocked?: boolean;
  reason?: string;
  owner?: string;
  has_more?: boolean;
  next_cursor?: string | null;
  scan_started_at?: string;
  consistency?: 'live_keyset_not_snapshot';
}

function decodeCursor(encoded: string, owner: string): InventoryCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) throw new Error();
    const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
    const c = decoded as Record<string, unknown>;
    if (Object.keys(c).sort().join(',') !== 'after,owner,started_at,v' ||
        c.v !== 1 || c.owner !== owner || !validId(c.after) ||
        typeof c.started_at !== 'string' || !ISO_RE.test(c.started_at) ||
        !Number.isFinite(Date.parse(c.started_at))) throw new Error();
    return c as unknown as InventoryCursor;
  } catch {
    throw new Error('memory_inventory_invalid_cursor');
  }
}

function metadata(row: Record<string, unknown>, owner: string): MemoryMetadata {
  if (row.agent !== owner || !validId(row.id)) throw new Error('memory_inventory_invalid_metadata');
  const kind = typeof row.kind === 'string' && (MEMORY_KINDS as readonly string[]).includes(row.kind)
    ? row.kind as MemoryKind : null;
  const created = typeof row.created_at === 'string' && ISO_RE.test(row.created_at) &&
    Number.isFinite(Date.parse(row.created_at)) ? new Date(row.created_at).toISOString() : null;
  // Invalid optional metadata remains visible as null rather than silently dropping the source ID.
  return { id: row.id, agent: owner, kind, created_at: created, metadata_valid: kind !== null && created !== null };
}

/** Read only ID/category/date metadata from the authenticated company lane's own partition. */
export async function inventoryOwnMemory(
  input: {
    callerAgent: string | null | undefined;
    requestedAgent?: string;
    cursor?: string;
    limit?: number;
    id?: string;
    kind?: MemoryKind;
    contains?: string;
  },
  query: typeof queryDocs = queryDocs,
): Promise<MemoryInventoryPage> {
  const owner = lane(input.callerAgent);
  if (!COMPANY_LANES.has(owner) || (input.requestedAgent !== undefined && lane(input.requestedAgent) !== owner)) {
    return { inventory: true, count: 0, records: [], status: 'denied', lookup_performed: false,
      blocked: true, reason: 'Memory inventory is limited to the authenticated company lane itself.' };
  }
  if (input.id !== undefined || input.kind !== undefined || input.contains !== undefined) {
    throw new Error('memory_inventory_does_not_accept_content_or_record_filters');
  }
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('memory_inventory_invalid_limit');
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor, owner) : undefined;
  const started = cursor?.started_at ?? new Date().toISOString();
  const conditions = ["c.type = 'memory'", 'c.agent = @agent'];
  const parameters: { name: string; value: unknown }[] = [{ name: '@agent', value: owner }];
  if (cursor) {
    conditions.push('c.id > @after');
    parameters.push({ name: '@after', value: cursor.after });
  }
  // Project metadata at the storage query, not after fetching source bodies. The partition
  // and agent predicate both derive from authenticated context, never from a cursor.
  let rows: Record<string, unknown>[];
  try {
    rows = await query('memory',
      `SELECT c.id, c.agent, c.kind, c.created_at FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.id ASC`,
      parameters, { pk: owner, max: limit + 1 });
  } catch {
    throw new Error('memory_inventory_provider_failure');
  }
  if (rows.length > limit + 1) throw new Error('memory_inventory_invalid_page');
  const checked = rows.map(row => metadata(row, owner));
  const records = checked.slice(0, limit);
  if (new Set(checked.map(row => row.id)).size !== checked.length) throw new Error('memory_inventory_duplicate_id');
  const more = checked.length > limit;
  const next = more ? Buffer.from(JSON.stringify({
    v: 1, owner, after: records[records.length - 1].id, started_at: started,
  } satisfies InventoryCursor)).toString('base64url') : null;
  return { inventory: true, count: records.length, records, status: 'success', lookup_performed: true,
    owner, has_more: more, next_cursor: next, scan_started_at: started, consistency: 'live_keyset_not_snapshot' };
}

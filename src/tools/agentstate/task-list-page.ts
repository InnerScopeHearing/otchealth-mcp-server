// Opt-in ID-keyset pagination. These pages do not form a consistent snapshot.
export interface PageScope {
  caller: string; board: string; owner: string | null; status: string | null;
  size: number; backend: string;
}
export interface PageRow { id: string }
export interface PageDeps<T extends PageRow, P extends PageRow> {
  fetchBatch: (after: string, limit: number) => Promise<T[]>;
  visibleTo: (task: T, caller: string) => boolean;
  project: (task: T, caller: string) => P;
}
const ID = /^[A-Za-z0-9_.-]{1,255}$/;
const validId = (s: unknown): s is string => typeof s === 'string' && ID.test(s) && !/^\.+$/.test(s);
const scopeKey = (s: PageScope): string => JSON.stringify([s.caller,s.board,s.owner,s.status,s.size,s.backend]);
const encode = (s: PageScope, after: string): string => Buffer.from(JSON.stringify({v:1,scope:scopeKey(s),after})).toString('base64url');
function decode(scope: PageScope, cursor: string): string {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw new Error('invalid_cursor');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw new Error('invalid_cursor'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_cursor');
  const c = value as Record<string, unknown>;
  if (c.v !== 1 || c.scope !== scopeKey(scope) || !validId(c.after)) throw new Error('invalid_cursor');
  return c.after;
}

/** Cursor is not an authorization token. Caller and filters must be enforced at every read. */
export async function taskPage<T extends PageRow, P extends PageRow>(scope: PageScope, cursor: string | undefined,
  deps: PageDeps<T, P>): Promise<{tasks:P[]; next_cursor:string|null; snapshot:false; scan_incomplete:boolean}> {
  if (!scope.caller || !scope.board || !scope.backend || !Number.isInteger(scope.size) || scope.size < 1 || scope.size > 100)
    throw new Error('invalid_input');
  let after = cursor === undefined ? '' : decode(scope, cursor);
  let queries = 0, exhausted = false;
  const rows: P[] = [];
  while (rows.length <= scope.size && queries < 4) {
    const cap = scope.size + 1;
    const batch = await deps.fetchBatch(after, cap);
    queries++;
    if (!Array.isArray(batch) || batch.length > cap) throw new Error('task_page_unavailable');
    for (const item of batch) {
      // This comparison is safe only for the PostgreSQL path with explicit C collation and ASCII IDs.
      if (!item || !validId(item.id) || (after && after >= item.id)) throw new Error('task_page_unavailable');
      after = item.id;
      if (deps.visibleTo(item, scope.caller)) {
        const projected = deps.project(item, scope.caller);
        if (!projected || projected.id !== item.id) throw new Error('task_page_unavailable');
        rows.push(projected);
        if (rows.length > scope.size) break;
      }
    }
    if (batch.length < cap) { exhausted = true; break; }
  }
  const output = rows.slice(0, scope.size);
  const more = rows.length > scope.size || !exhausted;
  if (more && output.length === 0) throw new Error('task_page_unavailable');
  return {tasks: output, next_cursor: more ? encode(scope, output[output.length - 1].id) : null,
    snapshot: false, scan_incomplete: !exhausted && rows.length <= scope.size};
}


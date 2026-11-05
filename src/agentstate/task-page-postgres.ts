// PostgreSQL ID-keyset reads for opt-in task-list pagination.
import type pg from 'pg';
export interface TaskPageQuery {
  board: string; owner?: string; status?: string; after?: string; limit: number; includePersonal: boolean;
}
const ID = /^[A-Za-z0-9_.-]{1,255}$/;
const AGENT = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const STATUS = new Set(['open','claimed','in_progress','blocked','done','cancelled','dead_letter']);
const validId = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && !/^\.+$/.test(v);

export function buildTaskPageQuery(i: TaskPageQuery): {text:string; values:(string|number)[]} {
  if (!validId(i.board) || (i.owner !== undefined && !AGENT.test(i.owner)) ||
      (i.status !== undefined && !STATUS.has(i.status)) || (i.after !== undefined && !validId(i.after)) ||
      !Number.isInteger(i.limit) || i.limit < 1 || i.limit > 101 || typeof i.includePersonal !== 'boolean')
    throw new Error('invalid_input');
  const values: (string|number)[] = [i.board];
  const bind = (v: string|number): string => { values.push(v); return `$${values.length}`; };
  const conditions = ['pk = $1', "doc->>'board' = $1", "doc->>'type' = 'task'"];
  if (!i.includePersonal) conditions.push(
    "(lower(btrim(doc->>'owner_agent')) <> 'clo-personal' OR doc->>'owner_agent' IS NULL)",
    "(lower(btrim(doc->>'created_by')) <> 'clo-personal' OR doc->>'created_by' IS NULL)",
  );
  if (i.owner !== undefined) conditions.push(`doc->>'owner_agent' = ${bind(i.owner)}`);
  if (i.status !== undefined) conditions.push(`doc->>'status' = ${bind(i.status)}`);
  if (i.after !== undefined) conditions.push(`id COLLATE "C" > ${bind(i.after)} COLLATE "C"`);
  const limit = bind(i.limit);
  return {text:`SELECT id, doc FROM agentstate_tasks WHERE ${conditions.join(' AND ')} ORDER BY id COLLATE "C" ASC LIMIT ${limit}`,values};
}

export async function queryTaskPage(pool: pg.Pool, input: TaskPageQuery): Promise<Record<string, unknown>[]> {
  const query = buildTaskPageQuery(input);
  let client: pg.PoolClient;
  try { client = await pool.connect(); } catch { throw new Error('task_page_unavailable'); }
  let begun = false, discard = false;
  try {
    await client.query('BEGIN READ ONLY');
    begun = true;
    await client.query("SET LOCAL statement_timeout = '2500ms'");
    const result = await client.query<{id:unknown;doc:Record<string,unknown>}>(query.text, query.values);
    if (!Array.isArray(result.rows) || result.rows.length > input.limit) throw new Error('bad_result');
    let previous = input.after ?? '';
    const docs = result.rows.map(row => {
      const d = row.doc;
      if (!validId(row.id) || !d || typeof d !== 'object' || d.id !== row.id ||
          !validId(d.board) || d.board !== input.board || d.type !== 'task' ||
          typeof d.owner_agent !== 'string' || !d.owner_agent.trim() || typeof d.created_by !== 'string' || !d.created_by.trim() ||
          (input.owner !== undefined && d.owner_agent !== input.owner) ||
          (input.status !== undefined && d.status !== input.status) ||
          (!input.includePersonal && [d.owner_agent,d.created_by].some(v => v.trim().toLowerCase() === 'clo-personal')) ||
          (previous && previous >= row.id)) throw new Error('bad_result');
      previous = row.id;
      return d;
    });
    await client.query('COMMIT');
    begun = false;
    return docs;
  } catch {
    if (begun) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
    else discard = true;
    throw new Error('task_page_unavailable');
  } finally {
    try { client.release(discard); } catch { throw new Error('task_page_unavailable'); }
  }
}


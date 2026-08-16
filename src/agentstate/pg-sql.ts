/**
 * Cosmos-SQL -> PostgreSQL translator for the agent-state plane.
 *
 * WHY THIS EXISTS
 * The agent-state store is moving from Cosmos DB for NoSQL to RDS Postgres. Nineteen call sites
 * pass Cosmos-flavoured SQL strings into queryDocs(), and two of them (searchMemory, listTasks)
 * BUILD their WHERE clause conditionally, so "just rewrite the callers to a structured API" is a
 * redesign of working code rather than a port. Translating instead keeps every caller and every
 * existing caller-level test meaningful.
 *
 * WHY IT IS SAFE
 * A translator's characteristic failure is turning input it half-understands into SQL that is
 * valid but means something else -- which is exactly the silent-wrong-answer class that produced
 * four separate cutover defects on 2026-08-15. So this parser is FAIL-CLOSED: it recognises only
 * the nine constructs that actually appear in this repo and throws on anything else. An
 * unsupported query therefore surfaces as a loud exception at the call site, never as quietly
 * wrong rows. Adding a construct is a deliberate edit here plus a test, not an accident.
 *
 * THE INJECTION BOUNDARY
 * Field names cannot be parameterised, so they are interpolated and must pass a strict identifier
 * check. Every value -- both @params and inline 'literals' -- binds as $n. Getting that split
 * backwards is where an injection would live, so the two paths are deliberately separate below.
 *
 * DOCUMENT MODEL
 * Each container is a table of (pk text, id text, doc jsonb, etag text). Cosmos's `c` alias maps
 * to the `doc` column, so `c.status` becomes `doc->>'status'`.
 */

/** Cosmos identifiers are case-sensitive and unquoted here, so restrict hard before interpolating. */
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function field(name: string): string {
  if (!FIELD_RE.test(name)) throw new Error(`unsupported field name in query: ${JSON.stringify(name)}`);
  return name;
}

export interface TranslateInput {
  /** Physical table name. Caller must have validated it against the container allow-list. */
  table: string;
  /** The Cosmos SQL text. */
  query: string;
  /** Cosmos-style bound parameters, e.g. [{ name: '@agent', value: 'cto' }]. */
  parameters: { name: string; value: unknown }[];
  /** Partition key to scope to, if the caller supplied one (single-partition query). */
  pk?: string;
  /** Hard row cap from the caller. Combined with any TOP in the query; the smaller wins. */
  max: number;
}

export interface TranslateResult {
  text: string;
  values: unknown[];
  /**
   * True when the SELECT was a projection (`SELECT c.a, c.b`) rather than `SELECT *`.
   * Both shapes return a single `doc` column, so the caller does not branch -- this is exposed
   * for tests and diagnostics only.
   */
  projected: boolean;
}

/**
 * Compare a JSON field against a bound value with the right type semantics.
 *
 * `->>` always yields text, so a numeric comparison through it would sort lexicographically
 * ("10" < "9"). Every predicate in this repo today compares ISO-8601 timestamps or plain strings,
 * where text ordering is already correct, but binding a number must not silently become a string
 * comparison -- so numbers and booleans get an explicit cast instead.
 */
function comparison(fieldName: string, op: string, value: unknown, placeholder: string): string {
  const lhs = `doc->>'${field(fieldName)}'`;
  if (typeof value === 'number') return `(${lhs})::numeric ${op} ${placeholder}::numeric`;
  if (typeof value === 'boolean') return `(${lhs})::boolean ${op} ${placeholder}::boolean`;
  return `${lhs} ${op} ${placeholder}`;
}

/**
 * Translate one Cosmos SQL statement.
 *
 * Supported grammar, in full:
 *   SELECT [TOP n] (* | c.f1, c.f2, ...) FROM c
 *     [WHERE <cond> (AND <cond>)*]
 *     [ORDER BY c.field [ASC|DESC]]
 *
 *   <cond> := c.field  = |<= |>= |< |>  @param
 *           | c.field  =                'literal'
 *           | CONTAINS(LOWER(c.field), @param)
 *           | IS_DEFINED(c.field)
 *
 * Everything else throws.
 */
export function translate(input: TranslateInput): TranslateResult {
  const { table, parameters, pk, max } = input;
  // Collapse whitespace so multi-line template literals parse identically to single-line ones.
  const sql = input.query.replace(/\s+/g, ' ').trim();

  const byName = new Map(parameters.map((p) => [p.name, p.value]));
  const values: unknown[] = [];
  const bind = (v: unknown): string => {
    values.push(v);
    return `$${values.length}`;
  };
  /** Resolve @param -> its bound value, rejecting references the caller never supplied. */
  const param = (name: string): unknown => {
    if (!byName.has(name)) throw new Error(`query references unbound parameter ${name}`);
    return byName.get(name);
  };

  const m = /^SELECT (?:TOP (\d+) )?(.+?) FROM c(?: WHERE (.+?))?(?: ORDER BY (.+?))?$/i.exec(sql);
  if (!m) throw new Error(`unsupported query shape (not translatable): ${sql.slice(0, 200)}`);
  const [, topRaw, selectList, whereRaw, orderRaw] = m;

  // ---- SELECT list -------------------------------------------------------------------------
  // `*` and the bare alias `c` both mean "the whole document". A projection is rebuilt as a
  // jsonb object so every shape returns exactly one `doc` column and the caller never branches.
  let projection = 'doc';
  let projected = false;
  const list = selectList.trim();
  if (list !== '*' && list !== 'c') {
    const cols = list.split(',').map((s) => s.trim());
    const pairs: string[] = [];
    for (const col of cols) {
      const cm = /^c\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(col);
      if (!cm) throw new Error(`unsupported SELECT item (only c.field projections): ${col}`);
      pairs.push(`'${field(cm[1])}', doc->'${field(cm[1])}'`);
    }
    projection = `jsonb_build_object(${pairs.join(', ')})`;
    projected = true;
  }

  // ---- WHERE -------------------------------------------------------------------------------
  const conds: string[] = [];
  if (whereRaw) {
    // Split on AND only. OR is deliberately unsupported: no caller uses it, and accepting it
    // without honouring precedence would be the classic valid-but-wrong translation.
    if (/\bOR\b/i.test(whereRaw)) throw new Error('OR is not supported by the agent-state translator');
    for (const rawCond of whereRaw.split(/\s+AND\s+/i)) {
      const cond = rawCond.trim();
      let cm: RegExpExecArray | null;

      // CONTAINS(LOWER(c.field), @param) -> case-insensitive substring.
      // position() is used rather than LIKE so the bound value needs no %/_ escaping; a search
      // term containing a wildcard would otherwise silently widen the match.
      if ((cm = /^CONTAINS\(\s*LOWER\(\s*c\.([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*,\s*(@[A-Za-z0-9_]+)\s*\)$/i.exec(cond))) {
        conds.push(`position(${bind(String(param(cm[2]) ?? ''))} in lower(doc->>'${field(cm[1])}')) > 0`);
        continue;
      }

      // IS_DEFINED(c.field) -> key present. Matches Cosmos, where an explicit null still counts
      // as defined, which is also true of jsonb_exists.
      if ((cm = /^IS_DEFINED\(\s*c\.([A-Za-z_][A-Za-z0-9_]*)\s*\)$/i.exec(cond))) {
        conds.push(`jsonb_exists(doc, '${field(cm[1])}')`);
        continue;
      }

      // c.field <op> @param
      if ((cm = /^c\.([A-Za-z_][A-Za-z0-9_]*)\s*(=|<=|>=|<|>)\s*(@[A-Za-z0-9_]+)$/.exec(cond))) {
        const v = param(cm[3]);
        conds.push(comparison(cm[1], cm[2], v, bind(v)));
        continue;
      }

      // c.field = 'literal'  (bound as a parameter, never interpolated)
      if ((cm = /^c\.([A-Za-z_][A-Za-z0-9_]*)\s*(=|<=|>=|<|>)\s*'([^']*)'$/.exec(cond))) {
        conds.push(comparison(cm[1], cm[2], cm[3], bind(cm[3])));
        continue;
      }

      throw new Error(`unsupported WHERE predicate (not translatable): ${cond}`);
    }
  }

  // Partition scoping is applied by the adapter, not written by callers, so it is appended here
  // rather than parsed. A cross-partition query simply omits it, exactly as Cosmos does.
  if (pk !== undefined) conds.push(`pk = ${bind(pk)}`);

  // ---- ORDER BY ----------------------------------------------------------------------------
  let order = '';
  if (orderRaw) {
    const om = /^c\.([A-Za-z_][A-Za-z0-9_]*)(?:\s+(ASC|DESC))?$/i.exec(orderRaw.trim());
    if (!om) throw new Error(`unsupported ORDER BY (only c.field [ASC|DESC]): ${orderRaw}`);
    order = ` ORDER BY doc->>'${field(om[1])}' ${(om[2] || 'ASC').toUpperCase()}`;
  }

  // ---- LIMIT -------------------------------------------------------------------------------
  // TOP and the caller's max are both hard caps; the tighter one wins so neither can be widened
  // by the other.
  const top = topRaw ? parseInt(topRaw, 10) : Number.POSITIVE_INFINITY;
  const limit = Math.max(1, Math.min(top, max));

  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const text = `SELECT ${projection} AS doc FROM ${table}${where}${order} LIMIT ${limit}`;
  return { text, values, projected };
}

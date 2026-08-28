import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate } from './pg-sql.js';

/**
 * Translator tests.
 *
 * Two jobs, and the second matters more than the first:
 *   1. every query this repo actually issues translates to the right Postgres
 *   2. everything else THROWS
 *
 * (2) is the safety property. A translator that guesses at input it half-understands produces
 * valid SQL with different meaning, which is invisible in review and in production -- the exact
 * failure class that produced four cutover defects on 2026-08-15. So the "rejects" tests below
 * are not defensive padding; they are the reason this approach is acceptable at all.
 */

const T = (query: string, parameters: { name: string; value: unknown }[] = [], opts: { pk?: string; max?: number } = {}) =>
  translate({ table: 'agentstate_memory', query, parameters, pk: opts.pk, max: opts.max ?? 100 });

// ---------------------------------------------------------------------------------------------
// THE SIX REAL PRODUCTION QUERIES. If one of these breaks, a live consumer breaks with it, so
// each is pinned verbatim from its call site rather than paraphrased.
// ---------------------------------------------------------------------------------------------

test('revocation-store: projection over an equality', () => {
  const r = T('SELECT c.hash, c.revoked_at, c.revoked_reason FROM c WHERE c.kind = @k', [
    { name: '@k', value: 'revoked_token' },
  ]);
  assert.equal(r.projected, true);
  assert.match(r.text, /jsonb_build_object\('hash', doc->'hash', 'revoked_at', doc->'revoked_at', 'revoked_reason', doc->'revoked_reason'\) AS doc/);
  assert.match(r.text, /WHERE doc->>'kind' = \$1/);
  assert.deepEqual(r.values, ['revoked_token']);
});

test('deindex-resweep: TOP + inline literal + range predicate', () => {
  const r = T(
    "SELECT TOP 25 * FROM c WHERE c.type = @type AND c.status = 'pending' AND c.due_at <= @now",
    [
      { name: '@type', value: 'deindex' },
      { name: '@now', value: '2026-08-15T12:00:00Z' },
    ],
    { max: 100 },
  );
  // The inline 'pending' must be BOUND, not interpolated -- that is the injection boundary.
  assert.deepEqual(r.values, ['deindex', 'pending', '2026-08-15T12:00:00Z']);
  assert.match(r.text, /doc->>'status' = \$2/);
  assert.match(r.text, /doc->>'due_at' <= \$3/);
  assert.match(r.text, /LIMIT 25$/, 'TOP 25 is tighter than max 100, so it wins');
});

test('searchMemory: the full dynamic clause, including CONTAINS(LOWER(..))', () => {
  const r = T(
    "SELECT * FROM c WHERE c.type = 'memory' AND c.agent = @agent AND c.kind = @kind AND CONTAINS(LOWER(c.text), @q) ORDER BY c.created_at DESC",
    [
      { name: '@agent', value: 'cto' },
      { name: '@kind', value: 'decision' },
      { name: '@q', value: 'cutover' },
    ],
    { pk: 'cto', max: 25 },
  );
  assert.match(r.text, /position\(\$4 in lower\(doc->>'text'\)\) > 0/);
  assert.match(r.text, /ORDER BY doc->>'created_at' DESC/);
  assert.match(r.text, /pk = \$5/, 'a single-partition query must be scoped to its pk');
  assert.match(r.text, /LIMIT 25$/);
  assert.deepEqual(r.values, ['memory', 'cto', 'decision', 'cutover', 'cto']);
});

test('listTasks: equality set with ORDER BY DESC', () => {
  const r = T("SELECT * FROM c WHERE c.board = @board AND c.type = 'task' AND c.status = @status ORDER BY c.created_at DESC", [
    { name: '@board', value: 'fleet' },
    { name: '@status', value: 'open' },
  ], { pk: 'fleet', max: 50 });
  assert.deepEqual(r.values, ['fleet', 'task', 'open', 'fleet']);
  assert.match(r.text, /ORDER BY doc->>'created_at' DESC LIMIT 50$/);
});

test('listEvents: ORDER BY ASC', () => {
  const r = T('SELECT * FROM c WHERE c.task_id = @tid ORDER BY c.ts ASC', [{ name: '@tid', value: 't_1' }], { pk: 't_1', max: 50 });
  assert.match(r.text, /ORDER BY doc->>'ts' ASC/);
});

test('retractions: IS_DEFINED maps to key-exists, not to NOT NULL', () => {
  // Cosmos IS_DEFINED is true for a property that exists with an explicit null. jsonb_exists
  // matches that; `doc->>'f' IS NOT NULL` would NOT, and would silently drop those rows.
  const r = T("SELECT c.agent, c.supersedes FROM c WHERE c.type = 'memory' AND IS_DEFINED(c.supersedes)", [], { max: 5000 });
  assert.match(r.text, /jsonb_exists\(doc, 'supersedes'\)/);
  assert.match(r.text, /LIMIT 5000$/);
});

// ---------------------------------------------------------------------------------------------
// FAIL-CLOSED. Each of these would be a plausible thing for a future caller to write, and each
// must throw rather than be approximated.
// ---------------------------------------------------------------------------------------------

test('REJECTS a JOIN', () => {
  assert.throws(() => T('SELECT * FROM c JOIN t IN c.tags WHERE t = @x', [{ name: '@x', value: 1 }]), /unsupported/i);
});

test('REJECTS OR rather than mistranslating its precedence', () => {
  assert.throws(
    () => T('SELECT * FROM c WHERE c.a = @a OR c.b = @b', [{ name: '@a', value: 1 }, { name: '@b', value: 2 }]),
    /OR is not supported/,
  );
});

test('REJECTS an aggregate', () => {
  assert.throws(() => T('SELECT VALUE COUNT(1) FROM c'), /unsupported/i);
});

test('REJECTS an unknown scalar function', () => {
  assert.throws(() => T('SELECT * FROM c WHERE STARTSWITH(c.name, @p)', [{ name: '@p', value: 'x' }]), /unsupported WHERE predicate/);
});

test('REJECTS ARRAY_CONTAINS', () => {
  assert.throws(() => T('SELECT * FROM c WHERE ARRAY_CONTAINS(c.tags, @t)', [{ name: '@t', value: 'a' }]), /unsupported WHERE predicate/);
});

test('REJECTS a nested-path field, which would need a different jsonb operator', () => {
  // doc->>'a.b' is NOT the same as doc->'a'->>'b'. Silently emitting the former would return
  // null for every row instead of erroring.
  assert.throws(() => T('SELECT * FROM c WHERE c.a.b = @p', [{ name: '@p', value: 1 }]), /unsupported WHERE predicate/);
});

test('REJECTS a parameter the caller never bound', () => {
  assert.throws(() => T('SELECT * FROM c WHERE c.agent = @nope'), /unbound parameter @nope/);
});

test('REJECTS ORDER BY on multiple fields', () => {
  assert.throws(() => T('SELECT * FROM c ORDER BY c.a DESC, c.b ASC'), /unsupported ORDER BY/);
});

// ---------------------------------------------------------------------------------------------
// Injection boundary + type semantics.
// ---------------------------------------------------------------------------------------------

test('INJECTION: a hostile field name is rejected, never interpolated', () => {
  assert.throws(
    () => T("SELECT * FROM c WHERE c.a'; DROP TABLE agentstate_memory; -- = @p", [{ name: '@p', value: 1 }]),
    /unsupported/i,
  );
});

// ---------------------------------------------------------------------------------------------
// TABLE_RE (2026-08-28): the module's own header calls the table/field split "THE INJECTION
// BOUNDARY", but until now only field() was enforced in code -- table trusted TranslateInput's
// doc comment ("Caller must have validated it") alone. The `T` helper above hardcodes
// `table: 'agentstate_memory'` for every other test in this file, so these call translate()
// directly to vary it. Not exploitable via the one real caller today (agentstate/postgres.ts's
// tableFor() already only emits `agentstate_<container>`) -- this is the guard against a second
// caller ever being trusted to re-derive that same discipline correctly.
// ---------------------------------------------------------------------------------------------

test('TABLE_RE: accepts the real production table name', () => {
  const r = translate({ table: 'agentstate_memory', query: 'SELECT * FROM c', parameters: [], max: 10 });
  assert.match(r.text, /FROM agentstate_memory /);
});

test('TABLE_RE: REJECTS a table name with an injected statement terminator', () => {
  assert.throws(
    () => translate({ table: 'agentstate_memory; DROP TABLE x', query: 'SELECT * FROM c', parameters: [], max: 10 }),
    /unsupported table name/i,
  );
});

test('TABLE_RE: REJECTS a quoted identifier (no quoting/escaping accepted)', () => {
  assert.throws(
    () => translate({ table: '"agentstate_memory"', query: 'SELECT * FROM c', parameters: [], max: 10 }),
    /unsupported table name/i,
  );
});

test('TABLE_RE: REJECTS mixed-case (Postgres identifiers are folded to lowercase unless quoted, so this table\'s real name is not what it looks like)', () => {
  assert.throws(
    () => translate({ table: 'Agentstate_Memory', query: 'SELECT * FROM c', parameters: [], max: 10 }),
    /unsupported table name/i,
  );
});

test('TABLE_RE: REJECTS an identifier over 63 bytes (Postgres\'s own NAMEDATALEN-1 identifier limit)', () => {
  assert.throws(
    () => translate({ table: 'a'.repeat(64), query: 'SELECT * FROM c', parameters: [], max: 10 }),
    /unsupported table name/i,
  );
  // A 63-char identifier (the boundary itself) is still accepted.
  const r = translate({ table: 'a'.repeat(63), query: 'SELECT * FROM c', parameters: [], max: 10 });
  assert.match(r.text, new RegExp(`FROM ${'a'.repeat(63)} `));
});

test('INJECTION: a hostile VALUE is harmless because it binds', () => {
  const r = T('SELECT * FROM c WHERE c.agent = @a', [{ name: '@a', value: "x'; DROP TABLE agentstate_memory; --" }]);
  assert.match(r.text, /doc->>'agent' = \$1/);
  assert.deepEqual(r.values, ["x'; DROP TABLE agentstate_memory; --"]);
  assert.equal(r.text.includes('DROP TABLE'), false, 'the value must never reach the SQL text');
});

test('a numeric bound value is cast, so it compares numerically not lexicographically', () => {
  // Without the cast, doc->>'n' > '9' would exclude '10' -- true-looking and wrong.
  const r = T('SELECT * FROM c WHERE c.n > @n', [{ name: '@n', value: 9 }]);
  assert.match(r.text, /\(doc->>'n'\)::numeric > \$1::numeric/);
});

test('a boolean bound value is cast', () => {
  const r = T('SELECT * FROM c WHERE c.done = @d', [{ name: '@d', value: true }]);
  assert.match(r.text, /\(doc->>'done'\)::boolean = \$1::boolean/);
});

test('the caller max wins when it is tighter than TOP', () => {
  const r = T('SELECT TOP 500 * FROM c', [], { max: 25 });
  assert.match(r.text, /LIMIT 25$/);
});

test('a cross-partition query omits the pk filter, as Cosmos does', () => {
  const r = T('SELECT * FROM c WHERE c.type = @t', [{ name: '@t', value: 'memory' }]);
  assert.equal(/pk = /.test(r.text), false);
});

test('multi-line SQL parses identically to single-line', () => {
  const r = T(`SELECT *
      FROM c
      WHERE c.agent = @a
      ORDER BY c.created_at DESC`, [{ name: '@a', value: 'cto' }]);
  assert.match(r.text, /WHERE doc->>'agent' = \$1 ORDER BY doc->>'created_at' DESC/);
});

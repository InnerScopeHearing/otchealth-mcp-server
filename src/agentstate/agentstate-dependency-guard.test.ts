import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ARCHITECTURE GUARD for the agent-state plane, the sibling of search/azure-dependency-guard.test.ts.
 *
 * The state plane is the LAST Azure runtime dependency and the one with the worst failure mode.
 * Search and documents degrade to "cannot read" when Azure goes away. State degrades to "cannot
 * WRITE": writeMemory() and memory-write.ts both await their create with no catch, so an Azure
 * suspension would not make the fleet forgetful, it would make it unable to record anything at all
 * -- including the record of what broke.
 *
 * The failure this guards against is not exotic. Four separate times on 2026-08-15 the same thing
 * happened: the data moved, one import did not, and the result was a plausible payload rather than
 * an error. Every offending line looked like ordinary, correct code. A structural test is the only
 * kind that catches it BEFORE the backend it points at is switched off -- a behavioural test only
 * fails once someone exercises that path against a dead Azure, which during a migration is far too
 * late.
 *
 * If one of these fails, the fix is almost never to edit this file. It is to import from
 * src/agentstate/store.ts (the dispatcher) so the call honours STATE_BACKEND like everything else.
 */

const SRC = new URL('..', import.meta.url).pathname;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }));

/** The only files allowed to reach a concrete state backend, each with the reason it is legitimate. */
const BACKEND_IMPORT_ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  'agentstate/store.ts': 'the dispatcher itself: it must import both backends to route between them',
  'agentstate/agentstate.test.ts': 'tests the Cosmos client directly, including its HMAC auth token construction',
});

test('THE SHOWSTOPPER: nothing imports a concrete state backend except the dispatcher', () => {
  // A consumer importing cosmos.js directly keeps writing to Azure no matter what STATE_BACKEND
  // says. On cutover that is silent: the write succeeds, against the wrong store.
  const offenders = FILES.filter(
    (f) => /from '(?:[^']*\/)?(cosmos|postgres)\.js'/.test(f.text) && !(f.path in BACKEND_IMPORT_ALLOWED),
  ).map((f) => f.path);

  assert.deepEqual(
    offenders,
    [],
    'These files import a state backend directly and would bypass STATE_BACKEND. ' +
      'Import from src/agentstate/store.js instead.',
  );
});

test('every allow-listed exception still exists, so the list cannot rot into a rubber stamp', () => {
  for (const path of Object.keys(BACKEND_IMPORT_ALLOWED)) {
    const f = FILES.find((x) => x.path === path);
    assert.ok(f, `allow-listed file no longer exists: ${path} -- remove it from BACKEND_IMPORT_ALLOWED`);
    assert.match(
      f!.text,
      /from '(?:[^']*\/)?(cosmos|postgres)\.js'/,
      `${path} no longer imports a backend directly -- remove its exemption`,
    );
  }
});

test('the dispatcher covers the ENTIRE Cosmos surface, so no caller needs to reach past it', () => {
  // Positive assertion, not just absence. A missing re-export is what pushes the next author into
  // importing cosmos.js directly "just for this one function", which is how the guard above starts
  // accumulating exemptions.
  const store = FILES.find((f) => f.path === 'agentstate/store.ts');
  assert.ok(store);
  for (const fn of [
    'createDoc',
    'readDoc',
    'replaceDoc',
    'deleteDoc',
    'upsertDoc',
    'queryDocs',
    'vectorSearchDocs',
    'newId',
    'isConfigured',
  ]) {
    assert.match(
      store!.text,
      new RegExp(`export (async )?function ${fn}\\b`),
      `store.ts must re-export ${fn}, or callers will import the backend directly to get it`,
    );
  }
});

test('both backends implement the same surface, so a STATE_BACKEND flip cannot 404 on a function', () => {
  // Cheapest possible check for the divergence that would only show up at runtime, on the one code
  // path someone forgot to port, after the flip.
  const cosmos = FILES.find((f) => f.path === 'agentstate/cosmos.ts');
  const postgres = FILES.find((f) => f.path === 'agentstate/postgres.ts');
  assert.ok(cosmos && postgres);
  for (const fn of [
    'createDoc',
    'readDoc',
    'replaceDoc',
    'deleteDoc',
    'upsertDoc',
    'queryDocs',
    'vectorSearchDocs',
    'newId',
    'isConfigured',
  ]) {
    const re = new RegExp(`export (async )?function ${fn}\\b`);
    assert.match(cosmos!.text, re, `cosmos.ts is missing ${fn}`);
    assert.match(postgres!.text, re, `postgres.ts is missing ${fn} -- a flip would break that call path`);
  }
});

test('the Postgres adapter parameterises values and never interpolates a caller string into SQL', () => {
  // The adapter builds SQL by hand, so this is the one place an injection could live. Table names
  // come from a fixed allow-list (tableFor) and LIMIT from a parsed integer; everything else must
  // be a $n placeholder.
  const pg = FILES.find((f) => f.path === 'agentstate/postgres.ts');
  assert.ok(pg);
  assert.match(pg!.text, /function tableFor/, 'container names must resolve through an allow-list');

  // Scope the scan to template literals that are actually SQL. An earlier version of this test
  // checked EVERY ${...} in the file and flagged error-message and id-construction interpolations,
  // which are irrelevant to injection -- a test that cries wolf gets weakened or deleted, so it is
  // worth narrowing to the thing that matters.
  const sqlLiterals = [...pg!.text.matchAll(/`([^`]*)`/g)]
    .map((m) => m[1])
    .filter((s) => /\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b/.test(s));
  assert.ok(sqlLiterals.length >= 6, `expected to find the adapter's SQL statements, found ${sqlLiterals.length}`);

  // Only two things may be interpolated into SQL: a table name from the allow-list, and a LIMIT
  // that was already clamped to an integer. Every value must be a $n placeholder.
  const allowed = new Set(['table', 'n']);
  const suspicious = sqlLiterals
    .flatMap((s) => [...s.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim()))
    .filter((x) => !allowed.has(x));
  assert.deepEqual(suspicious, [], `unexpected interpolation into adapter SQL: ${suspicious.join(', ')}`);
});

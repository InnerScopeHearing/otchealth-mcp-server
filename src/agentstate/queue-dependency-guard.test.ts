import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ARCHITECTURE GUARD for the agent-inbox plane -- the queue.ts/queue-azure.ts/queue-postgres.ts
 * sibling of agentstate-dependency-guard.test.ts (which covers the document store: cosmos.ts /
 * postgres.ts / store.ts). Same reasoning, scoped to the inbox: before queue.ts existed as a
 * dispatcher, the inbox called Azure Storage Queues unconditionally, ignoring STATE_BACKEND
 * entirely. A structural test is the only kind that would have caught that BEFORE Azure was
 * switched off for real, rather than the first time someone exercised agent_dispatch / inbox_read
 * / wake against a dead Azure during a migration.
 *
 * If one of these fails, the fix is almost never to edit this file. It is to import from
 * src/agentstate/queue.ts (the dispatcher) so the call honours STATE_BACKEND like everything else.
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

/**
 * The only files allowed to reach a concrete inbox backend, each with the reason it is legitimate.
 *
 * queue-postgres.test.ts / queue-postgres-unreachable.test.ts / queue-postgres-missing-table.test.ts
 * exercise the Postgres inbox adapter directly (drain/peek/concurrency/failure), the inbox's
 * counterpart to agentstate.test.ts importing cosmos.js directly -- but they use a DYNAMIC
 * `await import('./queue-postgres.js')` (so each file's own process.env snapshot, set before the
 * import, is what STATE_BACKEND/PG_* config loadEnv() sees -- see those files' headers), which the
 * regex below (matching static `from '...'` syntax) never flags in the first place. No entry is
 * needed here for them, exactly as the doc-store guard's own allow-list has no entry for
 * cosmos-aad.test.ts / cosmos-keymode.test.ts, which do the identical dynamic-import dance.
 */
const BACKEND_IMPORT_ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  'agentstate/queue.ts': 'the dispatcher itself: it must import both backends to route between them',
});

test('THE SHOWSTOPPER: nothing imports a concrete inbox backend except the dispatcher', () => {
  // A consumer importing queue-azure.js (or queue-postgres.js) directly keeps talking to that one
  // backend no matter what STATE_BACKEND says. On cutover that is silent: the call succeeds,
  // against the wrong store.
  const offenders = FILES.filter(
    (f) => /from '(?:[^']*\/)?(queue-azure|queue-postgres)\.js'/.test(f.text) && !(f.path in BACKEND_IMPORT_ALLOWED),
  ).map((f) => f.path);

  assert.deepEqual(
    offenders,
    [],
    'These files import an inbox backend directly and would bypass STATE_BACKEND. ' +
      'Import from src/agentstate/queue.js instead.',
  );
});

test('every allow-listed exception still exists, so the list cannot rot into a rubber stamp', () => {
  for (const path of Object.keys(BACKEND_IMPORT_ALLOWED)) {
    const f = FILES.find((x) => x.path === path);
    assert.ok(f, `allow-listed file no longer exists: ${path} -- remove it from BACKEND_IMPORT_ALLOWED`);
    assert.match(
      f!.text,
      /from '(?:[^']*\/)?(queue-azure|queue-postgres)\.js'/,
      `${path} no longer imports an inbox backend directly -- remove its exemption`,
    );
  }
});

test('the dispatcher covers the ENTIRE inbox surface, so no caller needs to reach past it', () => {
  const dispatcher = FILES.find((f) => f.path === 'agentstate/queue.ts');
  assert.ok(dispatcher);
  for (const fn of ['queueName', 'isConfigured', 'ensureQueue', 'enqueue', 'readMessages']) {
    assert.match(
      dispatcher!.text,
      new RegExp(`export (async )?function ${fn}\\b`),
      `queue.ts must re-export ${fn}, or callers will import a backend directly to get it`,
    );
  }
});

test('both inbox backends implement the same surface, so a STATE_BACKEND flip cannot 404 on a function', () => {
  const azure = FILES.find((f) => f.path === 'agentstate/queue-azure.ts');
  const postgres = FILES.find((f) => f.path === 'agentstate/queue-postgres.ts');
  assert.ok(azure && postgres);
  for (const fn of ['isConfigured', 'ensureQueue', 'enqueue', 'readMessages']) {
    const re = new RegExp(`export (async )?function ${fn}\\b`);
    assert.match(azure!.text, re, `queue-azure.ts is missing ${fn}`);
    assert.match(postgres!.text, re, `queue-postgres.ts is missing ${fn} -- a flip would break that call path`);
  }
});

test('no production file outside the two inbox backends calls fetch() against a *.queue.core.windows.net URL directly', () => {
  // Mirrors the doc-store guard's env-var-read scan, tuned to this plane's own bypass shape: a
  // future author could hand-roll a call to the Azure Queue REST API without importing
  // queue-azure.js at all (the exact class of bypass the doc-store guard's own header describes
  // finding on the search plane). Scoped to production files only, same reasoning as
  // agentstate-dependency-guard.test.ts's PROD_FILES: a test file constructing a fake URL as its
  // own fixture is not a bypass.
  const PROD_FILES = FILES.filter((f) => !f.path.endsWith('.test.ts'));
  const AZURE_QUEUE_URL_ALLOWED: Readonly<Record<string, string>> = Object.freeze({
    'agentstate/queue-azure.ts': 'the designated Azure Storage Queue adapter',
  });
  const offenders = PROD_FILES.filter((f) => {
    if (f.path in AZURE_QUEUE_URL_ALLOWED) return false;
    return /queue\.core\.windows\.net/.test(f.text);
  }).map((f) => f.path);
  assert.deepEqual(
    offenders,
    [],
    'These files reference the Azure Queue endpoint directly, bypassing STATE_BACKEND: ' + offenders.join(', '),
  );
});

test('the Postgres inbox adapter parameterises values and never interpolates a caller string into SQL', () => {
  // Mirrors agentstate-dependency-guard.test.ts's identical check on postgres.ts. The agent name
  // (via queueName) is the one caller-controlled value that reaches every statement in this file;
  // it must always arrive as a $n placeholder, never as a template-literal interpolation.
  const pg = FILES.find((f) => f.path === 'agentstate/queue-postgres.ts');
  assert.ok(pg);

  const sqlLiterals = [...pg!.text.matchAll(/`([^`]*)`/g)]
    .map((m) => m[1])
    .filter((s) => /\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b/.test(s));
  assert.ok(sqlLiterals.length >= 3, `expected to find the adapter's SQL statements, found ${sqlLiterals.length}`);

  // Only the fixed table-name constant (TABLE, never caller-supplied) may be interpolated.
  // Everything else -- the queue name, limits, visibility seconds -- must be a $n placeholder.
  const allowed = new Set(['TABLE']);
  const suspicious = sqlLiterals
    .flatMap((s) => [...s.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim()))
    .filter((x) => !allowed.has(x));
  assert.deepEqual(suspicious, [], `unexpected interpolation into inbox adapter SQL: ${suspicious.join(', ')}`);
});

test('the Postgres inbox adapter routes the agent id through queueName() before it reaches SQL', () => {
  // queueName() -> normalizeAgent() is the existing identifier/parameter validation this plane
  // already relies on elsewhere (agent-state ledger, the Azure queue-name shape). The task here is
  // not to invent a second validator; it is confirmed present so a future edit cannot quietly drop
  // the call and start binding a raw, unvalidated agent string instead.
  const pg = FILES.find((f) => f.path === 'agentstate/queue-postgres.ts');
  assert.ok(pg);
  assert.match(pg!.text, /queueName\(agent\)/, 'queue-postgres.ts must normalize/validate the agent id via queueName() before use');
});

test('both inbox backends throw rather than swallow a failure (no catch that returns an empty result)', () => {
  // The load-bearing requirement from this plane's own incident history: a broken inbox must never
  // read as an empty one. A `catch` block anywhere in these files that returns instead of
  // rethrowing would silently turn a real outage into "0 messages".
  for (const path of ['agentstate/queue-azure.ts', 'agentstate/queue-postgres.ts']) {
    const f = FILES.find((x) => x.path === path);
    assert.ok(f);
    // Matches `catch (e) { ... return` / `catch { ... return` with only whitespace/comments
    // between them -- a catch block whose first real statement is a return, rather than a rethrow.
    const stripped = f!.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(
      stripped,
      /catch\s*(\([^)]*\))?\s*\{\s*(\/\/[^\n]*\n\s*)*return\b/,
      `${path} has a catch block that returns instead of rethrowing -- a real failure would look like an empty inbox`,
    );
  }
});

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

/**
 * ===================== ENV-VAR-READ SCAN (2026-08-16) =====================
 *
 * WHY THIS SECTION EXISTS: every check above scans for an IMPORT STATEMENT naming the concrete
 * cosmos or postgres module (see THE SHOWSTOPPER test's own regex above). That misses a bypass
 * that reads COSMOS_ENDPOINT/COSMOS_KEY directly and rolls its own request instead of importing
 * anything --
 * exactly the shape found this session in the SIBLING search plane (src/memory/semantic.ts read
 * `e.AZURE_SEARCH_ENDPOINT` off loadEnv() and issued its own fetch(); src/memory/agentic.ts read
 * `process.env['AZURE_SEARCH_ENDPOINT']` directly; neither imported azure/search.js or
 * search/opensearch.js, so no import-statement regex could ever see either one). The state plane
 * this file guards has the WORST failure mode of the three (see the file header: writes fail
 * outright, not just reads), so it gets the identical class of check the search plane just proved
 * it needed, tuned to this file's own family: COSMOS_* (STATE_BACKEND). See
 * search/azure-dependency-guard.test.ts's copy of this section for the AZURE_SEARCH_, AZURE_BLOB_,
 * FOUNDRY_, and AZURE_OPENAI_ families, and for why the split follows each guard's existing theme
 * instead of duplicating the full five-family list in both files.
 *
 * FILE SCOPE, DELIBERATELY NARROWER THAN `FILES` ABOVE: the existing `FILES` constant includes
 * `.test.ts` files on purpose (agentstate/agentstate.test.ts's own import-of-cosmos.js exemption
 * needs that). This scan must NOT: a test file setting `process.env.COSMOS_ENDPOINT = '...'` as its
 * own fixture setup (every dispatch-scenario test in this repo does exactly that -- see
 * agentstate/cosmos-aad.test.ts, cosmos-keymode.test.ts, safety/shadow-eval.test.ts, and this very
 * file's neighbours) is not a bypass, it is the correct and expected way to configure a test
 * scenario. Scanning test fixtures for this pattern would either force a large, meaningless
 * allow-list or make this check permanently red for reasons that have nothing to do with the
 * defect it exists to catch -- so `PROD_FILES` below is `FILES` filtered back down to
 * production-only, used ONLY by the checks in this section; every check above this section keeps
 * using the original `FILES` unchanged.
 */
const PROD_FILES = FILES.filter((f) => !f.path.endsWith('.test.ts'));

/** Strips /* block *\/ comments and // line comments before the env-var-read scan runs, so a
 *  file's own prose describing this exact bug (including this section's own header above) cannot
 *  trip a check meant to catch a REAL code read. Mirrors
 *  search/azure-dependency-guard.test.ts's identical helper (duplicated rather than imported --
 *  neither guard file imports from the other, or from a shared non-test module, by design: each is
 *  a fully self-contained structural check over the raw source tree). See that file's own comment
 *  for the URL / regex-literal edge cases this handles and the direct node -e verification run
 *  against them before this was relied on.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Matches a real property/bracket read of a COSMOS_* env var: `.COSMOS_FOO`, `['COSMOS_FOO']`, or
 *  `["COSMOS_FOO"]`. Unanchored to a specific receiver for the same reason as the search guard's
 *  copy of this pattern (see that file). DELIBERATELY NO `g` FLAG -- every use below is a boolean
 *  `.test()` call reused across many different strings in a loop; a global-flagged RegExp is
 *  stateful (`lastIndex` persists across calls) and would silently miss a real violation depending
 *  on call order. See search/azure-dependency-guard.test.ts's identical constant for a direct,
 *  verified (node -e) repro of exactly that failure mode before this fix and its absence after. */
const COSMOS_ENV_VAR_READ_RE = /\.(COSMOS_\w+)\b|\[['"](COSMOS_\w+)['"]\]/;

/** Files allowed to read a COSMOS_* env var directly, with the reason. Keep this list SMALL --
 *  every entry is a place STATE_BACKEND cannot reach. */
const COSMOS_ENV_VAR_READ_ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  'agentstate/cosmos.ts': 'the designated Cosmos adapter -- agentstate/store.ts (the dispatcher) reaches Azure only through this file',
  'server/deep-health.ts':
    'FLAGGED, not endorsed -- outside this fix\'s ownership (src/server/), reported separately rather than fixed here. Same file as the identical allow-list entry in search/azure-dependency-guard.test.ts: a deploy-gate live-reachability probe that deliberately reads process.env directly (documented in its own header, for freshness) but hardcodes Azure\'s own COSMOS_ENDPOINT/COSMOS_KEY regardless of STATE_BACKEND, so post-cutover it will probe a dependency that may no longer be the one in use. Allow-listed so this guard stays a true CI gate today; its owner should repoint it at agentstate/store.ts\'s isConfigured()/dispatch surface (or an equivalent STATE_BACKEND-aware probe) rather than raw Cosmos env vars.',
});

test('no production file outside the designated Cosmos adapter reads COSMOS_* directly', () => {
  const offenders = PROD_FILES.filter((f) => {
    if (f.path in COSMOS_ENV_VAR_READ_ALLOWED) return false;
    return COSMOS_ENV_VAR_READ_RE.test(stripComments(f.text));
  }).map((f) => f.path);

  assert.deepEqual(
    offenders,
    [],
    'These files read COSMOS_ENDPOINT/COSMOS_KEY/COSMOS_DB/COSMOS_AUTH_MODE directly, bypassing ' +
      'STATE_BACKEND even though they import nothing the checks above would catch. Import from ' +
      'src/agentstate/store.ts instead, or add the file to COSMOS_ENV_VAR_READ_ALLOWED with a ' +
      'reason if it is a genuinely designated adapter.',
  );
});

test('every COSMOS_* env-var-read allow-list exception still exists and still needs its exemption', () => {
  for (const path of Object.keys(COSMOS_ENV_VAR_READ_ALLOWED)) {
    const f = PROD_FILES.find((x) => x.path === path);
    assert.ok(f, `allow-listed file no longer exists (or is now a .test.ts, out of PROD_FILES scope): ${path} -- remove it from COSMOS_ENV_VAR_READ_ALLOWED`);
    assert.equal(
      COSMOS_ENV_VAR_READ_RE.test(stripComments(f!.text)),
      true,
      `${path} no longer reads COSMOS_* directly -- remove its exemption`,
    );
  }
});

test('KNOWN-POSITIVE self-test: the COSMOS_* env-var-read scan actually detects a synthetic offender', () => {
  // Without this, the regex/allow-list machinery above could be silently loosened to match nothing
  // and "no offenders" would keep passing for the wrong reason -- exactly how the pre-fix blind
  // spot in the search plane's sibling guard survived undetected. Proves the DETECTOR still fires,
  // independent of whatever PROD_FILES happens to contain today.
  const syntheticOffenders = [
    { path: 'fake/dot-access.ts', text: "const ep = e.COSMOS_ENDPOINT || '';" },
    { path: 'fake/bracket-single-quote.ts', text: "const key = process.env['COSMOS_KEY'];" },
    { path: 'fake/bracket-double-quote.ts', text: 'const db = process.env["COSMOS_DB"];' },
  ];
  for (const f of syntheticOffenders) {
    assert.equal(
      COSMOS_ENV_VAR_READ_RE.test(stripComments(f.text)),
      true,
      `detector failed to flag a synthetic offender at ${f.path} -- the scan has been silently weakened`,
    );
  }
});

test('KNOWN-NEGATIVE self-test: a comment merely describing COSMOS_*, and an unrelated var, are NOT flagged', () => {
  const syntheticClean = [
    { path: 'fake/doc-comment.ts', text: '// this file used to read e.COSMOS_ENDPOINT directly, now it does not\nexport const x = 1;' },
    { path: 'fake/url-with-double-slash.ts', text: "const url = 'https://cosmos-otc-agentstate-55c84.documents.azure.com:443/';" },
    { path: 'fake/trailing-slash-regex.ts', text: "const ep = (endpoint || '').replace(/\\/+$/, '');" },
    { path: 'fake/unrelated-var.ts', text: 'const acct = env.AZURE_COMMONS_STORAGE_ACCOUNT;' },
  ];
  for (const f of syntheticClean) {
    assert.equal(
      COSMOS_ENV_VAR_READ_RE.test(stripComments(f.text)),
      false,
      `detector false-positived on a clean file at ${f.path} -- the scan is too broad and will force noisy, meaningless allow-listing`,
    );
  }
});

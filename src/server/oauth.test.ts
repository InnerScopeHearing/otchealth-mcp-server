import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// oauth.ts calls loadEnv() at module top level (`const env = loadEnv();`), so it must be imported
// AFTER the required env vars are set -- dynamic import inside each test, run after before() has
// populated process.env. Mirrors catalog-warm.test.ts's pattern for the same underlying reason.
//
// Pins the Phase 5/6 connector-ring closure (2026-07-15), layer 2: laneFromClientName()'s fallback
// for an UNRECOGNIZED connector name used to be 'clo' -- a privileged EXEC_RING lane. Any Claude.ai
// account holder who added this gateway as a custom connector and gave it a name that didn't match
// any known lane code/alias got a bearer token bound to 'clo', which passed every privileged ring
// check (kb_search_privileged, legal_blob_*) and (pre-Part-1) saw the full privileged toolset. The
// fallback now resolves to 'external-read', a non-privileged lane. Known exec aliases (e.g. a
// connector explicitly named "CFO Finance") are UNCHANGED and still map to their lane -- this test
// locks that both facts stay true: the unrecognized-name fallback is fixed, and the deliberate
// aliasing feature for named lanes is not touched by this change.

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
  // Deliberately leave OAUTH_DCR_DEFAULT_AGENT unset so the built-in default ('external-read') is
  // what gets exercised below, not an operator override.
});

// NOTE ON TEST-STRING CHOICE: DCR_LANES matches by plain substring (`n.includes(needle)`), so a name
// containing an ORDINARY ENGLISH WORD that happened to contain a lane needle also matched -- e.g.
// "My Custom Connector" and "Directory Bot" both contain "cto" (conne-CTO-r, dire-CTO-ry) and used
// to resolve to 'cto'; "Cloud Sync" contains "clo" (CLOud) and used to resolve to 'clo'. That was a
// substring-collision hole in the matching algorithm itself; Part 5 (below) CLOSES it by switching
// to word-boundary (`\b<needle>\b`) matching. The strings below still contain none of the DCR_LANES
// needles as WHOLE WORDS, so they exercise the fallback path; the dedicated collision cases (words
// that contain a needle only as a substring) are in the Part-5 block further down.
test("SAFETY-CRITICAL: an unrecognized connector name defaults to 'external-read', not a privileged lane (THE HOLE this closes)", async () => {
  const { laneFromClientName } = await import('./oauth.js');
  assert.equal(laneFromClientName('randostring'), 'external-read');
  assert.equal(laneFromClientName('Untitled MCP Client'), 'external-read');
  assert.equal(laneFromClientName('Perplexity Assistant'), 'external-read');
  assert.equal(laneFromClientName(''), 'external-read');
});

test('known exec aliases in DCR_LANES still map correctly (unchanged, deliberately not touched)', async () => {
  const { laneFromClientName } = await import('./oauth.js');
  assert.equal(laneFromClientName('CFO connector'), 'cfo');
  assert.equal(laneFromClientName('CFO Finance'), 'cfo');
  assert.equal(laneFromClientName('CTO'), 'cto');
  assert.equal(laneFromClientName('legal ops'), 'clo');
  assert.equal(laneFromClientName('clo-personal thread'), 'clo-personal');
  assert.equal(laneFromClientName('developer seat'), 'developer');
  assert.equal(laneFromClientName('Compliance Officer'), 'cco');
  assert.equal(laneFromClientName('Revenue bot'), 'cro');
});

test('multi-word codes still match before their prefixes (clo-personal before clo, unchanged)', async () => {
  const { laneFromClientName } = await import('./oauth.js');
  assert.equal(laneFromClientName('clo-personal'), 'clo-personal');
  assert.equal(laneFromClientName('clo'), 'clo');
});

// ── Part 5: word-boundary DCR lane matching (closes the substring-collision hole) ──────────────
// The layer-2 fix moved the FALLBACK off 'clo', but the matcher still used n.includes(needle), so
// an ordinary connector name containing a lane code as a SUBSTRING resolved to that (often
// privileged) lane before the fallback ever ran. Virtually every connector name contains
// "connector" -> "cto", so the fallback almost never fired -- the hole was still wide open. Part 5
// switches to `\b<needle>\b`, so only a WHOLE-WORD lane code routes to a lane; everything else falls
// through to the non-privileged 'external-read'. These cases lock that behavior.

test("SAFETY-CRITICAL Part 5: substring-collision names resolve to 'external-read', not a privileged lane", async () => {
  const { laneFromClientName } = await import('./oauth.js');
  // Each of these contains a lane code only as an internal substring (no word boundary around it):
  //   "connector"/"directory"/"factory"/"vector" contain "cto"/"cro" mid-word; "cloud" contains "clo".
  for (const name of ['My Custom Connector', 'Cloud Sync', 'Directory Bot', 'Factory Assistant', 'Vector Store', 'some random connector']) {
    assert.equal(laneFromClientName(name), 'external-read', `${name} must fall through to external-read, not a privileged/ship lane`);
  }
});

test('Part 5: legitimate whole-word lane codes + role aliases still route correctly', async () => {
  const { laneFromClientName } = await import('./oauth.js');
  assert.equal(laneFromClientName('CTO'), 'cto');
  assert.equal(laneFromClientName('OTCHealth CTO Connector'), 'cto'); // 'cto' as a whole word wins; 'connector' does NOT collide
  assert.equal(laneFromClientName('CFO Finance'), 'cfo');
  assert.equal(laneFromClientName('Legal Assistant'), 'clo'); // 'legal' role alias as a whole word
  assert.equal(laneFromClientName('Technology Bot'), 'cto'); // 'technology' role alias as a whole word
});

test('Part 5: clo-personal precedence is PRESERVED under word-boundary matching', async () => {
  const { laneFromClientName } = await import('./oauth.js');
  // `\bclo-personal\b` is tested before `\bclo\b` (ordered list), so this resolves to clo-personal,
  // never to the broader clo lane -- the single most important precedence to keep intact.
  assert.equal(laneFromClientName('clo-personal matter'), 'clo-personal');
  assert.equal(laneFromClientName('CLO-PERSONAL divorce file'), 'clo-personal');
});

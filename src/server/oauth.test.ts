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
// containing an ORDINARY ENGLISH WORD that happens to contain a lane needle also matches -- e.g.
// "My Custom Connector" and "Directory Bot" both contain "cto" (conne-CTO-r, dire-CTO-ry) and resolve
// to 'cto'; "Cloud Sync" contains "clo" (CLOud) and resolves to 'clo'. That is a SEPARATE, PRE-EXISTING
// substring-collision issue in the matching algorithm itself (present before this change and NOT
// touched by it -- the task scope is the FALLBACK default only; DCR_LANES matching is explicitly
// out of scope here). Flagged to the CTO in this PR's report for a follow-up decision. The test
// strings below are deliberately chosen to contain NONE of the DCR_LANES needles, so they exercise
// only the fallback path this Part actually changes.
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

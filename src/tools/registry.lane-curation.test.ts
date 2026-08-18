import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Wave 6 item 6.2 (per-lane tool-catalog curation for internal client_credentials lanes).
//
// These tests exercise the REAL registration path (registerAllTools -> registry.ts's registerTool)
// against a fresh McpServer per case, reading the server's own `_registeredTools` map (the MCP SDK's
// internal registration table -- same shape catalog-warm.test.ts already relies on for its
// tool-count floor) so this proves what actually gets ADVERTISED, not just what the pure helpers
// compute in isolation.
//
// THE CENTRAL GUARANTEE UNDER TEST: TOOL_CATALOG_CURATION_MODE's default (unset, or 'report', or
// 'off') must NEVER narrow any lane's advertised toolset below the full catalog. Only an explicit
// TOOL_CATALOG_CURATION_MODE=curate may narrow a KNOWN internal lane, and even then an unscoped lane
// stays uncurated (fail-open).

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
});

afterEach(() => {
  delete process.env.TOOL_CATALOG_CURATION_MODE;
  delete process.env.TOOL_CATALOG_CURATE_LANES;
});

async function registeredToolCount(lane: string, isM365 = false): Promise<number> {
  return (await registeredToolNames(lane, isM365)).length;
}

async function registeredToolNames(lane: string, isM365 = false): Promise<string[]> {
  const { registerAllTools } = await import('./index.js');
  const { currentCallerHash, requestContext } = await import('../server/request-context.js');
  const mcp = new McpServer(
    { name: 'test', version: '0' },
    { capabilities: { tools: { listChanged: true }, logging: {} } },
  );
  await requestContext.run(
    {
      callerHash: 'test-hash',
      correlationId: 'test-corr',
      callerAgent: lane,
      connectorSurface: false,
      m365StaticAuth: isM365,
    },
    async () => {
      registerAllTools(mcp, currentCallerHash);
    },
  );
  // `_registeredTools` is the MCP SDK's own internal registration table (an object keyed by tool
  // name) -- reading it here proves what THIS server instance actually advertises, independent of
  // the shared module-level Capability Catalog singleton (which upserts by name across every
  // registerAllTools() call in the process and would not isolate one invocation's result).
  return Object.keys((mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

test('DEFAULT (TOOL_CATALOG_CURATION_MODE unset) -- every known internal lane gets the FULL, uncurated catalog', async () => {
  delete process.env.TOOL_CATALOG_CURATION_MODE;
  const lanes = ['cto', 'cfo', 'clo', 'clo-personal', 'coo', 'cro', 'cpo', 'cco', 'developer', 'exec'];
  const counts = await Promise.all(lanes.map((lane) => registeredToolCount(lane)));
  const unscopedCount = await registeredToolCount('some-unscoped-lane');
  for (const [i, lane] of lanes.entries()) {
    assert.equal(
      counts[i],
      unscopedCount,
      `lane ${lane} should register the SAME tool count as an unscoped lane by default (got ${counts[i]} vs ${unscopedCount})`,
    );
    assert.ok(counts[i] >= 800, `lane ${lane} should see >= 800 tools by default, got ${counts[i]}`);
  }
});

test("explicit TOOL_CATALOG_CURATION_MODE=report -- identical to the default (never restricts)", async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'report';
  const reportCount = await registeredToolCount('developer');
  delete process.env.TOOL_CATALOG_CURATION_MODE;
  const defaultCount = await registeredToolCount('developer');
  assert.equal(reportCount, defaultCount);
  assert.ok(reportCount >= 800);
});

test("explicit TOOL_CATALOG_CURATION_MODE=off -- also never restricts", async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'off';
  const offCount = await registeredToolCount('cfo');
  assert.ok(offCount >= 800);
});

test('TOOL_CATALOG_CURATION_MODE=curate -- narrows a KNOWN internal lane below the full catalog', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate';
  const fullCount = await registeredToolCount('some-unscoped-lane'); // unscoped: fail-open, stays full
  const developerCount = await registeredToolCount('developer');
  assert.ok(fullCount >= 800, `unscoped lane should stay at the full catalog even in curate mode, got ${fullCount}`);
  assert.ok(
    developerCount < fullCount,
    `curate mode should narrow the 'developer' lane below the full catalog (got ${developerCount} vs ${fullCount})`,
  );
  assert.ok(developerCount > 0, 'developer lane should still see a non-empty toolset');
});

test('TOOL_CATALOG_CURATION_MODE=curate -- an unscoped/unknown lane is NEVER curated (fail-open)', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate';
  const unscopedCount = await registeredToolCount('some-random-app-lead-agent');
  const defaultLikeCount = await registeredToolCount('another-unscoped-lane');
  assert.equal(unscopedCount, defaultLikeCount);
  assert.ok(unscopedCount >= 800);
});

// curate-m365-only (2026-07-31, the M365 Copilot tools/list-size fix): the REAL registration-path
// lock a Copilot review correctly asked for -- the pure evaluateCatalogCuration() unit tests in
// tool-catalog-curation.test.ts prove the decision function is right in isolation, but only this
// suite proves the SDK's actual _registeredTools table (what a real tools/list response advertises)
// respects it, including the finalizeM365Aliases() interaction the review flagged.

test('TOOL_CATALOG_CURATION_MODE=curate-m365-only -- an M365 static-auth caller on a known lane is narrowed', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate-m365-only';
  const fullCount = await registeredToolCount('some-unscoped-lane', true);
  const developerM365Count = await registeredToolCount('developer', true);
  assert.ok(fullCount >= 800, `unscoped lane should stay at the full catalog, got ${fullCount}`);
  assert.ok(
    developerM365Count < fullCount,
    `curate-m365-only should narrow an M365 'developer' caller below the full catalog (got ${developerM365Count} vs ${fullCount})`,
  );
  assert.ok(developerM365Count > 0, 'developer lane should still see a non-empty toolset');
});

test('TOOL_CATALOG_CURATION_MODE=curate-m365-only -- THE CORE SAFETY PROPERTY: a non-M365 caller on the SAME known lane is NEVER narrowed, unlike plain curate mode', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate-m365-only';
  const developerNonM365Count = await registeredToolCount('developer', false);
  const fullCount = await registeredToolCount('some-unscoped-lane', false);
  assert.equal(
    developerNonM365Count,
    fullCount,
    'a non-M365 caller (e.g. a live Claude Code exec session) on the developer lane must see the FULL catalog even while curate-m365-only is active -- this is the entire reason this mode exists over plain curate',
  );
  assert.ok(developerNonM365Count >= 800);
});

// TOOL_CATALOG_CURATE_LANES (2026-08-18, "cro advertises tools it can never use" finding): the
// real-registration lock for the per-lane opt-in that lets curate-m365-only narrow a specific lane's
// PLAIN client_credentials (non-M365) traffic too, without touching any other lane's behavior --
// i.e. without flipping the deployed mode to plain 'curate', which would narrow every lane at once.

test('TOOL_CATALOG_CURATE_LANES: a non-M365 caller on a lane NAMED in the override IS narrowed under curate-m365-only', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate-m365-only';
  process.env.TOOL_CATALOG_CURATE_LANES = 'developer';
  const fullCount = await registeredToolCount('some-unscoped-lane', false);
  const narrowedCount = await registeredToolCount('developer', false);
  assert.ok(
    narrowedCount < fullCount,
    `a non-M365 'developer' caller should be narrowed once 'developer' is named in TOOL_CATALOG_CURATE_LANES (got ${narrowedCount} vs ${fullCount})`,
  );
  assert.ok(narrowedCount > 0, 'the opted-in lane should still see a non-empty toolset');
});

test('TOOL_CATALOG_CURATE_LANES: naming ONE lane does not narrow any OTHER known lane (no blast radius beyond the named lane)', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate-m365-only';
  process.env.TOOL_CATALOG_CURATE_LANES = 'developer';
  const fullCount = await registeredToolCount('some-unscoped-lane', false);
  const cfoCount = await registeredToolCount('cfo', false); // known internal lane, NOT named in the override
  assert.equal(
    cfoCount,
    fullCount,
    `naming 'developer' in TOOL_CATALOG_CURATE_LANES must not narrow 'cfo' too -- a non-M365 cfo caller should stay fully uncurated (got ${cfoCount} vs ${fullCount})`,
  );
});

test('TOOL_CATALOG_CURATE_LANES: multiple comma-separated lanes are ALL honored', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate-m365-only';
  process.env.TOOL_CATALOG_CURATE_LANES = 'developer,cfo';
  const fullCount = await registeredToolCount('some-unscoped-lane', false);
  const developerCount = await registeredToolCount('developer', false);
  const cfoCount = await registeredToolCount('cfo', false);
  assert.ok(developerCount < fullCount, 'developer must be narrowed');
  assert.ok(cfoCount < fullCount, 'cfo must be narrowed too -- both names in the csv take effect');
});

test('TOOL_CATALOG_CURATE_LANES: unset (the default) changes nothing -- byte-identical to curate-m365-only before this feature existed', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate-m365-only';
  delete process.env.TOOL_CATALOG_CURATE_LANES;
  const fullCount = await registeredToolCount('some-unscoped-lane', false);
  const developerCount = await registeredToolCount('developer', false);
  assert.equal(
    developerCount,
    fullCount,
    'with no override configured, a non-M365 developer caller must still see the full catalog under curate-m365-only, exactly as before this feature',
  );
});

test('TOOL_CATALOG_CURATE_LANES: an unknown/garbage lane name in the csv is silently ignored (fail-open), never crashes registration', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate-m365-only';
  process.env.TOOL_CATALOG_CURATE_LANES = 'not-a-real-lane, ,cro-typo';
  const fullCount = await registeredToolCount('some-unscoped-lane', false);
  const developerCount = await registeredToolCount('developer', false);
  assert.equal(developerCount, fullCount, 'a garbage override list must behave identically to no override at all');
});

test('TOOL_CATALOG_CURATE_LANES: has no effect under mode=curate (already unconditional) or mode=report/off (never curate)', async () => {
  process.env.TOOL_CATALOG_CURATE_LANES = 'developer';
  const fullCount = await registeredToolCount('some-unscoped-lane', false);

  process.env.TOOL_CATALOG_CURATION_MODE = 'curate';
  const curateWithOverride = await registeredToolCount('developer', false);
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate';
  delete process.env.TOOL_CATALOG_CURATE_LANES;
  const curateWithoutOverride = await registeredToolCount('developer', false);
  assert.equal(curateWithOverride, curateWithoutOverride, 'plain curate mode already curates unconditionally; the lane override changes nothing');

  process.env.TOOL_CATALOG_CURATE_LANES = 'developer';
  process.env.TOOL_CATALOG_CURATION_MODE = 'report';
  const reportWithOverride = await registeredToolCount('developer', false);
  assert.equal(reportWithOverride, fullCount, 'report mode never curates, override or not');

  process.env.TOOL_CATALOG_CURATION_MODE = 'off';
  const offWithOverride = await registeredToolCount('developer', false);
  assert.equal(offWithOverride, fullCount, 'off mode never curates, override or not');
});

// DEDUP FIX (2026-08-02): this test used to LOCK IN the doubling bug as expected behavior ("roughly
// DOUBLE the raw seed-allowlist size... Lock the actual observed ratio"). Live measurement against
// production that day found the doubling made curate-m365-only nearly self-defeating for the two
// broadest lanes (cto: 905 seed-admitted canonical tools -> 1655 advertised once aliases were added;
// cro: 485 -> 899) -- the alias shim was unconditionally advertising BOTH the long canonical name and
// the short M365 alias for nearly every admitted tool, even though M365 Copilot's own tool-calling
// orchestrator has been repeatedly confirmed to call ONLY the short stripped form, never the long one
// (see this shim's header in registry.ts). registry.ts now `.remove()`s the redundant long-form
// primary once its short alias is confirmed unambiguous, so each admitted canonical tool is advertised
// EXACTLY ONCE to an M365 caller (under whichever name Copilot will actually call), not twice.
test('TOOL_CATALOG_CURATION_MODE=curate-m365-only -- an M365 developer caller sees each seed-admitted canonical tool advertised EXACTLY ONCE (no long+short duplicate pair)', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate-m365-only';
  const { isToolInLaneAllowlist } = await import('../config/lane-toolsets.js');
  // The full canonical catalog, uncurated (default mode, non-M365 -- no aliases, no narrowing) --
  // this is the ground truth "every real tool name" list to filter against the lane's allowlist.
  delete process.env.TOOL_CATALOG_CURATION_MODE;
  const allCanonicalNames = await registeredToolNames('some-unscoped-lane', false);
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate-m365-only';
  const admittedCanonical = allCanonicalNames.filter((n) => isToolInLaneAllowlist('developer', n));
  assert.ok(admittedCanonical.length > 0, 'developer lane should admit at least some canonical tools');

  const names = await registeredToolNames('developer', true);
  // THE LOAD-BEARING ASSERTION: no more doubling. Every admitted canonical tool contributes exactly
  // one advertised name (its own, or its unambiguous alias) -- so the total advertised count equals
  // the admitted-canonical count, not ~2x it. A small number of admitted tools can lose their alias
  // to an ambiguous stripped-name collision with another canonical tool OUTSIDE this lane's allowlist
  // (finalizeM365Aliases runs over the whole server's candidates, not just this lane's), in which case
  // they keep their long form -- still exactly one registration each either way.
  //
  // ONE KNOWN, PRE-EXISTING, INTENTIONAL EXCEPTION (predates this fix, unrelated to the auto-generated
  // M365 shim this test targets): memory/recall-alias.ts registers a SECOND, hand-built, ALWAYS-ON
  // (not M365-gated) tool literally named "recall" (canonicalName: 'memory_recall'), documented there
  // as deliberately permanent -- deleting it would break "recall" for every non-M365 caller that
  // already depends on it. Its bare name "recall" does not itself match any lane pattern (only its
  // canonicalName 'memory_recall' does, via the memory_* wildcard), so it is invisible to this test's
  // bare-name-based `admittedCanonical` computation even though it legitimately registers at runtime --
  // it is intentionally excluded from the auto-generated alias/dedup machinery entirely (finalizeM365Aliases
  // already special-cases it via primaryNames.has('recall')). This is the ONLY tool in the fleet with
  // this shape today; the tolerance below is deliberately tight (1, not a percentage) so a REAL
  // regression (the doubling bug coming back) still fails loudly.
  const KNOWN_PERMANENT_HANDBUILT_ALIASES = 1; // memory/recall-alias.ts's "recall"
  assert.ok(
    names.length >= admittedCanonical.length && names.length <= admittedCanonical.length + KNOWN_PERMANENT_HANDBUILT_ALIASES,
    `M365 curated 'developer' registration should advertise each of the ${admittedCanonical.length} ` +
      `seed-admitted canonical tools essentially ONCE (under its canonical or alias name, +/- the ` +
      `${KNOWN_PERMANENT_HANDBUILT_ALIASES} known permanent hand-built compat alias), got ${names.length} ` +
      `total names -- a mismatch means either the dedup fix regressed (names.length far > admitted, the ` +
      `long+short duplicate pair is back) or curation itself regressed (names.length < admitted, a real ` +
      `tool went missing).`,
  );
  // And the property this whole feature exists for: nowhere near the unscoped ~1665-tool M365 catalog.
  const fullM365Count = await registeredToolCount('some-unscoped-lane', true);
  assert.ok(
    names.length < fullM365Count / 3,
    `curated 'developer' M365 registration (${names.length}) should be well under a third of the ` +
      `unscoped M365 catalog size (${fullM365Count}), not balloon back toward it`,
  );
});

// REAL-REGISTRATION LOCK for cto/cro (2026-08-02 Copilot review on PR #185): the dedup test above only
// ever exercised the 'developer' lane. cto and cro are the two lanes this PR's Bug-2 fix (overbroad
// wildcards -> CTO_M365_CURATED / CRO_M365_CURATED explicit lists) actually targets, and the ONLY
// coverage they had was config/lane-toolsets.test.ts's isToolInLaneAllowlist() string-membership check
// (one positive/negative pair for cto, none for cro) -- a typo, stale name, or accidental broadening in
// either curated array would not fail CI. These two tests close that gap by exercising the SAME real
// registerAllTools() -> McpServer._registeredTools path as the developer test above, locking a concrete
// upper bound (not just "< full catalog") and asserting representative required tools survive.
for (const [lane, upperBound, mustInclude] of [
  ['cto', 240, ['brain_search', 'azure_jobs_list', 'github_branch_get', 'cio_admin_read_workspace_health']],
  ['cro', 240, ['brain_search', 'cio_track_event', 'revenuecat_customer_get', 'cio_admin_read_workspace_health']],
  // 2026-08-02: developer_wake_lite was silently excluded from the developer lane's M365-curated
  // registration (no wildcard/exact match in LANE_TOOLSETS.developer covered it) -- invisible to
  // catalog_probe's known_tools_present check (which reads the full unscoped catalog, not this
  // lane's curated view), so it looked "present" there while being genuinely uncallable by an M365
  // developer caller. Locks the fix at the real registration layer, not just the seed-list layer.
  ['developer', 200, ['brain_search', 'developer_wake_lite', 'catalog_probe']],
] as const) {
  test(`TOOL_CATALOG_CURATION_MODE=curate-m365-only -- an M365 '${lane}' caller is narrowed to a concrete bound and keeps its representative tools (2026-08-02 Bug-2 fix)`, async () => {
    process.env.TOOL_CATALOG_CURATION_MODE = 'curate-m365-only';
    const names = await registeredToolNames(lane, true);
    assert.ok(names.length > 0, `${lane} lane should still see a non-empty toolset`);
    assert.ok(
      names.length <= upperBound,
      `${lane}'s M365-curated registration should stay at or under ${upperBound} tools ` +
        `(PR #199 adds a fixed 42-tool governed Customer.io admin surface; branch CI measured 220/218 ` +
        `for cto/cro, so 240 is a bounded ceiling, not the exact count) -- got ${names.length}. A ` +
        `count blowing past this means CTO_M365_CURATED/CRO_M365_CURATED regressed toward a wildcard ` +
        `again or the dedup fix broke.`,
    );
    for (const tool of mustInclude) {
      // A representative tool may be advertised under its OWN canonical name, or under its
      // dedup-surviving short alias (registry.ts's finalizeM365Aliases strips everything before the
      // first underscore once the alias is unambiguous and removes the long-form primary) -- either
      // form means the tool is genuinely still reachable by an M365 caller. Only its total absence
      // under BOTH forms is a real regression (dropped from the curated list, or newly ambiguous).
      const strippedAlias = /^[^_]+_(.+)$/.exec(tool)?.[1];
      const reachable = names.includes(tool) || (!!strippedAlias && names.includes(strippedAlias));
      assert.ok(
        reachable,
        `${lane}'s M365-curated registration must still make "${tool}" reachable, under its ` +
          `canonical name or its stripped alias "${strippedAlias}" -- got neither`,
      );
    }
  });
}

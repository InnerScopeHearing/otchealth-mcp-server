import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseToolCatalogCurationMode,
  evaluateCatalogCuration,
  recordLaneToolUsage,
} from './tool-catalog-curation.js';
import { buildCapturePayload } from '../telemetry/gateway-ops.js';

test('parseToolCatalogCurationMode: DEFAULTS to report (unset, empty, or garbage input)', () => {
  assert.equal(parseToolCatalogCurationMode(undefined), 'report');
  assert.equal(parseToolCatalogCurationMode(''), 'report');
  assert.equal(parseToolCatalogCurationMode('   '), 'report');
  assert.equal(parseToolCatalogCurationMode('nonsense'), 'report');
  assert.equal(parseToolCatalogCurationMode('CURATED'), 'report'); // must be an exact 'curate', not a fuzzy match
});

test('parseToolCatalogCurationMode: recognizes off/report/curate/curate-m365-only, case-insensitively, trimmed', () => {
  assert.equal(parseToolCatalogCurationMode('off'), 'off');
  assert.equal(parseToolCatalogCurationMode(' OFF '), 'off');
  assert.equal(parseToolCatalogCurationMode('report'), 'report');
  assert.equal(parseToolCatalogCurationMode('REPORT'), 'report');
  assert.equal(parseToolCatalogCurationMode('curate'), 'curate');
  assert.equal(parseToolCatalogCurationMode('Curate'), 'curate');
  assert.equal(parseToolCatalogCurationMode('curate-m365-only'), 'curate-m365-only');
  assert.equal(parseToolCatalogCurationMode(' CURATE-M365-ONLY '), 'curate-m365-only');
});

test('evaluateCatalogCuration: mode=off is a full no-op regardless of lane/tool', () => {
  const d = evaluateCatalogCuration('off', 'developer', 'azure_job_execute');
  assert.deepEqual(d, { mode: 'off', advertise: true, inSeedAllowlist: null });
});

test('evaluateCatalogCuration: mode=report NEVER sets advertise=false, even for a tool outside the seed list', () => {
  const d = evaluateCatalogCuration('report', 'developer', 'azure_job_execute');
  assert.equal(d.advertise, true, 'report mode must never restrict advertising');
  assert.equal(d.inSeedAllowlist, false, 'but it still annotates the seed-allowlist membership for telemetry');
});

test('evaluateCatalogCuration: mode=report on a tool that IS in the seed list', () => {
  const d = evaluateCatalogCuration('report', 'developer', 'github_create_branch');
  assert.equal(d.advertise, true);
  assert.equal(d.inSeedAllowlist, true);
});

test('evaluateCatalogCuration: mode=curate actually withholds advertise for an out-of-seed tool on a known lane', () => {
  const d = evaluateCatalogCuration('curate', 'developer', 'azure_job_execute');
  assert.equal(d.advertise, false);
  assert.equal(d.inSeedAllowlist, false);
});

test('evaluateCatalogCuration: mode=curate still advertises an in-seed tool', () => {
  const d = evaluateCatalogCuration('curate', 'developer', 'brain_search');
  assert.equal(d.advertise, true);
  assert.equal(d.inSeedAllowlist, true);
});

test('evaluateCatalogCuration: an UNKNOWN lane is never curated, in ANY mode (fail-open)', () => {
  for (const mode of ['off', 'report', 'curate', 'curate-m365-only'] as const) {
    const d = evaluateCatalogCuration(mode, 'some-unscoped-lane', 'azure_job_execute', true);
    assert.equal(d.advertise, true, `mode=${mode} must not restrict an unscoped lane`);
    if (mode === 'off') {
      assert.equal(d.inSeedAllowlist, null);
    } else {
      assert.equal(d.inSeedAllowlist, null, `mode=${mode}: an unscoped lane has no seed-allowlist question to answer`);
    }
  }
});

test('evaluateCatalogCuration: empty-string lane (no OAuth agent identity) is treated as unscoped, never curated', () => {
  const d = evaluateCatalogCuration('curate', '', 'azure_job_execute');
  assert.equal(d.advertise, true);
  assert.equal(d.inSeedAllowlist, null);
});

test('evaluateCatalogCuration: mode=curate-m365-only withholds advertise for an out-of-seed tool WHEN isM365=true', () => {
  const d = evaluateCatalogCuration('curate-m365-only', 'developer', 'azure_job_execute', true);
  assert.equal(d.advertise, false);
  assert.equal(d.inSeedAllowlist, false);
});

test('evaluateCatalogCuration: mode=curate-m365-only still advertises an in-seed tool WHEN isM365=true', () => {
  const d = evaluateCatalogCuration('curate-m365-only', 'developer', 'github_create_branch', true);
  assert.equal(d.advertise, true);
  assert.equal(d.inSeedAllowlist, true);
});

test('evaluateCatalogCuration: mode=curate-m365-only NEVER restricts a non-M365 caller on the SAME known lane (the safety property this mode exists for -- protects a live Claude Code exec session sharing a lane with an M365 static token)', () => {
  const d = evaluateCatalogCuration('curate-m365-only', 'developer', 'azure_job_execute', false);
  assert.equal(d.advertise, true, 'a non-M365 caller must see the full catalog even in curate-m365-only mode');
  assert.equal(d.inSeedAllowlist, false, 'seed-allowlist membership is still annotated for telemetry');
});

test('evaluateCatalogCuration: isM365 defaults to false when omitted (back-compat call sites never accidentally curate)', () => {
  const d = evaluateCatalogCuration('curate-m365-only', 'developer', 'azure_job_execute');
  assert.equal(d.advertise, true);
});

test('evaluateCatalogCuration: mode=curate (the unscoped mode) still curates a caller even when isM365=false -- curate-m365-only is the ONLY mode conditioned on isM365', () => {
  const d = evaluateCatalogCuration('curate', 'developer', 'azure_job_execute', false);
  assert.equal(d.advertise, false, 'plain curate mode must remain unconditional on isM365, unchanged from before this feature');
});

test('recordLaneToolUsage: mode=off never throws and is inert (nothing to assert on the network side, covered by gateway-ops tests)', () => {
  assert.doesNotThrow(() => {
    recordLaneToolUsage({ mode: 'off', advertise: true, inSeedAllowlist: null }, 'cfo', 'xero_report');
  });
});

test('recordLaneToolUsage: report/curate modes never throw even with no telemetry key configured', () => {
  assert.doesNotThrow(() => {
    recordLaneToolUsage({ mode: 'report', advertise: true, inSeedAllowlist: true }, 'cfo', 'xero_report');
    recordLaneToolUsage({ mode: 'curate', advertise: false, inSeedAllowlist: false }, 'developer', 'azure_job_execute');
  });
});

// The gw_lane_tool_used payload SHAPE, built via the same pure buildCapturePayload helper
// captureGatewayEvent uses internally (telemetry/gateway-ops.ts) -- mirrors how gateway-ops.test.ts
// locks in gw_mutation / gw_doctrine_surfaced's shapes, so a future refactor cannot silently rename
// or reshape the fields the usage-refinement workflow (config/lane-toolsets.ts's header) depends on.
test('gw_lane_tool_used payload shape (the usage-data event this feature emits)', () => {
  const p = buildCapturePayload(
    'gw_lane_tool_used',
    { lane: 'cfo', tool: 'xero_report', in_seed_allowlist: true, mode: 'report' },
    'caller-hash-abc',
    'phc_test',
  );
  assert.ok(p);
  assert.equal(p!.event, 'gw_lane_tool_used');
  assert.equal(p!.distinct_id, 'caller-hash-abc');
  assert.equal(p!.properties.lane, 'cfo');
  assert.equal(p!.properties.tool, 'xero_report');
  assert.equal(p!.properties.in_seed_allowlist, true);
  assert.equal(p!.properties.mode, 'report');
});

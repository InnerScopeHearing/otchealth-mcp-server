import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HEYGEN_DATA_LANES,
  HEYGEN_DATA_TOOLS,
  HEYGEN_PAIRING_TOOLS,
  isHeyGenToolAllowed,
} from './access.js';
import { LANE_TOOLSETS, isToolInLaneAllowlist } from '../../config/lane-toolsets.js';
import { requiredRoleFor, roleAllows } from '../../catalog/governance.js';

test('data tools allow exactly cto/exec/coo/cro/cpo/developer; pair tools allow only cto', () => {
  const allKnownAndExternal = [
    'cto', 'exec', 'coo', 'cro', 'cpo', 'developer',
    'cfo', 'clo', 'clo-personal', 'cco', 'external-read', 'unknown', '',
  ];
  for (const tool of HEYGEN_DATA_TOOLS) {
    for (const lane of allKnownAndExternal) {
      assert.equal(
        isHeyGenToolAllowed(tool, lane),
        (HEYGEN_DATA_LANES as readonly string[]).includes(lane),
        `${tool} / ${lane || '(empty)'}`,
      );
    }
    assert.equal(isHeyGenToolAllowed(tool, undefined), false);
    assert.equal(isHeyGenToolAllowed(tool, null), false);
  }
  for (const tool of HEYGEN_PAIRING_TOOLS) {
    for (const lane of allKnownAndExternal) {
      assert.equal(isHeyGenToolAllowed(tool, lane), lane === 'cto', `${tool} / ${lane || '(empty)'}`);
    }
  }
});

test('internal catalog lane seeds include every HeyGen tool only for the six approved internal lanes', () => {
  const allTools = [...HEYGEN_PAIRING_TOOLS, ...HEYGEN_DATA_TOOLS];
  for (const lane of HEYGEN_DATA_LANES) {
    assert.ok(LANE_TOOLSETS[lane].includes('heygen_*'), `${lane} must carry the explicit heygen_* catalog pattern`);
    for (const tool of allTools) {
      assert.equal(isToolInLaneAllowlist(lane, tool), true, `${lane} must advertise ${tool}`);
    }
  }
  for (const lane of ['cfo', 'clo', 'clo-personal', 'cco']) {
    for (const tool of allTools) {
      assert.equal(isToolInLaneAllowlist(lane, tool), false, `${lane} must not advertise ${tool}`);
    }
  }
});

test('governance duplicates the exact in-handler lane model: pairing CTO-only, reads six-lane only', () => {
  for (const tool of HEYGEN_PAIRING_TOOLS) {
    const rule = requiredRoleFor(tool);
    assert.ok(rule, `${tool} needs an exact governance rule`);
    assert.equal(roleAllows(rule!.role, 'cto'), true);
    for (const lane of ['exec', 'coo', 'cro', 'cpo', 'developer', 'external-read']) {
      assert.equal(roleAllows(rule!.role, lane), false, `${tool} must reject ${lane}`);
    }
  }
  for (const tool of HEYGEN_DATA_TOOLS) {
    const rule = requiredRoleFor(tool);
    assert.ok(rule, `${tool} needs an exact six-lane governance rule`);
    for (const lane of HEYGEN_DATA_LANES) {
      assert.equal(roleAllows(rule!.role, lane), true, `${tool} must allow ${lane}`);
    }
    for (const lane of ['cfo', 'clo', 'clo-personal', 'cco', 'external-read', 'unknown', '']) {
      assert.equal(roleAllows(rule!.role, lane), false, `${tool} must reject ${lane || '(empty)'}`);
    }
  }
});

test('SAFETY-CRITICAL: every registered HeyGen tool call-site has its own explicit in-handler lane gate', () => {
  const source = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
  const registrations = (source.match(/registerTool\(/g) ?? []).length;
  const gates = (source.match(/if \(!isHeyGenToolAllowed\(/g) ?? []).length;
  const refusals = (source.match(/return heyGenLaneRefusal\(/g) ?? []).length;
  assert.equal(registrations, 6, 'public HeyGen surface must remain exactly 2 pairing + 4 data tools');
  assert.equal(gates, registrations, 'every registerTool call-site must explicitly check its caller lane');
  assert.equal(refusals, registrations, 'every explicit gate must return a lane refusal');
});

test('public HeyGen surface is fixed read-only data plus pairing; no generic/mutating media tool is exposed', () => {
  assert.deepEqual([...HEYGEN_DATA_TOOLS], [
    'heygen_account_get',
    'heygen_videos_list',
    'heygen_video_get',
    'heygen_video_agent_styles_list',
  ]);
  const exposed = [...HEYGEN_PAIRING_TOOLS, ...HEYGEN_DATA_TOOLS].join(' ');
  for (const forbidden of ['request', 'generate', 'create', 'upload', 'delete', 'download', 'translate', 'send', 'stop']) {
    assert.equal(exposed.includes(`heygen_${forbidden}`), false, `must not expose heygen_${forbidden}*`);
  }
});

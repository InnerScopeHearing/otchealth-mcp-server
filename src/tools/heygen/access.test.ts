import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HEYGEN_CREATION_TOOLS,
  HEYGEN_DATA_LANES,
  HEYGEN_DATA_TOOLS,
  HEYGEN_PAIRING_TOOLS,
  isHeyGenToolAllowed,
} from './access.js';
import { LANE_TOOLSETS, isToolInLaneAllowlist } from '../../config/lane-toolsets.js';
import { requiredRoleFor, roleAllows } from '../../catalog/governance.js';
import {
  redactHeyGenPromptAvatarInputForLog,
  redactHeyGenVoiceDesignInputForLog,
} from './redaction.js';

test('data tools allow exactly cto/exec/coo/cro/cpo/developer; pairing/create tools allow only cto', () => {
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
  for (const tool of [...HEYGEN_PAIRING_TOOLS, ...HEYGEN_CREATION_TOOLS]) {
    for (const lane of allKnownAndExternal) {
      assert.equal(isHeyGenToolAllowed(tool, lane), lane === 'cto', `${tool} / ${lane || '(empty)'}`);
    }
  }
});

test('internal catalog lane seeds include every HeyGen tool only for the six approved internal lanes', () => {
  const allTools = [...HEYGEN_PAIRING_TOOLS, ...HEYGEN_DATA_TOOLS, ...HEYGEN_CREATION_TOOLS];
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

test('governance duplicates the exact in-handler lane model: pairing/create CTO-only, data six-lane only', () => {
  for (const tool of [...HEYGEN_PAIRING_TOOLS, ...HEYGEN_CREATION_TOOLS]) {
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
  assert.equal(registrations, 13, 'public HeyGen surface must remain exactly 2 pairing + 10 data + 1 bounded creation tool');
  assert.equal(gates, registrations, 'every registerTool call-site must explicitly check its caller lane');
  assert.equal(refusals, registrations, 'every explicit gate must return a lane refusal');
});

test('public HeyGen surface is fixed and excludes generic/destructive/media-generation capabilities', () => {
  assert.deepEqual([...HEYGEN_DATA_TOOLS], [
    'heygen_account_get',
    'heygen_videos_list',
    'heygen_video_get',
    'heygen_video_agent_styles_list',
    'heygen_avatar_groups_list',
    'heygen_avatar_group_get',
    'heygen_avatar_looks_list',
    'heygen_avatar_look_get',
    'heygen_voices_list',
    'heygen_voice_design',
  ]);
  assert.deepEqual([...HEYGEN_CREATION_TOOLS], ['heygen_prompt_avatar_create']);
  const exposed = [...HEYGEN_PAIRING_TOOLS, ...HEYGEN_DATA_TOOLS, ...HEYGEN_CREATION_TOOLS];
  for (const forbidden of [
    'heygen_request',
    'heygen_avatar_delete',
    'heygen_avatar_update',
    'heygen_avatar_upload',
    'heygen_photo_avatar_create',
    'heygen_digital_twin_create',
    'heygen_voice_clone',
    'heygen_voice_delete',
    'heygen_speech_create',
    'heygen_video_generate',
    'heygen_translate',
    'heygen_tts',
  ]) {
    assert.equal(exposed.includes(forbidden), false, `must not expose ${forbidden}`);
  }

  const source = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('reference_images'), false, 'prompt-avatar input must never expose reference_images');
  assert.match(source, /name: 'heygen_prompt_avatar_create',[\s\S]*?category: 'write_simple'/);
  assert.doesNotMatch(source, /name: 'heygen_prompt_avatar_create',[\s\S]*?category: 'write_orchestrated'/);
});

test('prompt-bearing HeyGen tools log only SHA-256 fingerprints, never full prompts', () => {
  const prompt = 'SENSITIVE FULL PROMPT THAT MUST NEVER ENTER STRUCTURED TOOL LOGS';
  const createLog = redactHeyGenPromptAvatarInputForLog({
    name: 'Presenter',
    prompt,
    avatar_group_id: 'group-1',
    confirm_credit_use: true,
    confirmed_premium_credits_before: 7,
  });
  const voiceLog = redactHeyGenVoiceDesignInputForLog({ prompt, gender: 'female', locale: 'en-US' });
  for (const payload of [createLog, voiceLog]) {
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(prompt), false);
    assert.match(serialized, /[a-f0-9]{64}/);
  }
  assert.deepEqual(Object.keys(createLog as Record<string, unknown>).sort(), [
    'avatar_group_id',
    'confirm_credit_use',
    'confirmed_premium_credits_before',
    'name',
    'prompt_sha256',
  ]);
  assert.deepEqual(Object.keys(voiceLog as Record<string, unknown>).sort(), [
    'gender',
    'locale',
    'prompt_sha256',
    'seed',
  ]);
  assert.equal((createLog as Record<string, unknown>).confirm_credit_use, true);
  assert.equal((createLog as Record<string, unknown>).confirmed_premium_credits_before, 7);

  const registrySource = readFileSync(new URL('../registry.ts', import.meta.url), 'utf8');
  assert.match(registrySource, /input: def\.redactInputForLog/);
  assert.match(registrySource, /args: def\.redactInputForLog/);
});

test('connector curation includes every exact HeyGen tool only in the CTO ship set', () => {
  const source = readFileSync(new URL('../registry.ts', import.meta.url), 'utf8');
  const shipStart = source.indexOf('export const CTO_SHIP_LANE_TOOLSET');
  const externalStart = source.indexOf('export const EXTERNAL_READONLY_TOOLSET');
  const externalEnd = source.indexOf('export function isShipLane', externalStart);
  assert.ok(shipStart >= 0 && externalStart > shipStart && externalEnd > externalStart);
  const ship = source.slice(shipStart, externalStart);
  const external = source.slice(externalStart, externalEnd);
  for (const tool of [...HEYGEN_PAIRING_TOOLS, ...HEYGEN_DATA_TOOLS, ...HEYGEN_CREATION_TOOLS]) {
    assert.ok(ship.includes(`'${tool}'`), `CTO ship set must include ${tool}`);
    assert.equal(external.includes(`'${tool}'`), false, `external-readonly set must exclude ${tool}`);
  }
});

test('HeyGen tools register before M365 alias finalization', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  assert.ok(source.indexOf('registerHeyGenTools(server, callerHash)') >= 0);
  assert.ok(
    source.indexOf('registerHeyGenTools(server, callerHash)') < source.indexOf('finalizeM365Aliases(server, callerHash)'),
  );
});

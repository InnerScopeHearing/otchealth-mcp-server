import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HEYGEN_CREATION_TOOLS,
  HEYGEN_DATA_LANES,
  HEYGEN_DATA_TOOLS,
  HEYGEN_METADATA_TOOLS,
  HEYGEN_PAIRING_TOOLS,
  HEYGEN_PREFLIGHT_TOOLS,
  isHeyGenToolAllowed,
} from './access.js';
import { LANE_TOOLSETS, isToolInLaneAllowlist } from '../../config/lane-toolsets.js';
import { requiredRoleFor, roleAllows } from '../../catalog/governance.js';
import {
  redactHeyGenAvatarVideoInputForLog,
  redactHeyGenPromptAvatarInputForLog,
  redactHeyGenReferenceLookInputForLog,
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
  for (const tool of HEYGEN_PREFLIGHT_TOOLS) {
    for (const lane of allKnownAndExternal) {
      assert.equal(
        isHeyGenToolAllowed(tool, lane),
        (HEYGEN_DATA_LANES as readonly string[]).includes(lane),
        `${tool} / ${lane || '(empty)'}`,
      );
    }
  }
  for (const tool of [...HEYGEN_PAIRING_TOOLS, ...HEYGEN_CREATION_TOOLS]) {
    for (const lane of allKnownAndExternal) {
      assert.equal(isHeyGenToolAllowed(tool, lane), lane === 'cto', `${tool} / ${lane || '(empty)'}`);
    }
  }
});

test('internal catalog lane seeds include every HeyGen tool only for the six approved internal lanes', () => {
  const allTools = [...HEYGEN_PAIRING_TOOLS, ...HEYGEN_DATA_TOOLS, ...HEYGEN_METADATA_TOOLS, ...HEYGEN_PREFLIGHT_TOOLS, ...HEYGEN_CREATION_TOOLS];
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
  for (const tool of HEYGEN_METADATA_TOOLS) {
    const rule = requiredRoleFor(tool);
    assert.ok(rule, `${tool} needs an exact cto/cro governance rule`);
    for (const lane of ['cto', 'cro']) assert.equal(roleAllows(rule!.role, lane), true, `${tool} must allow ${lane}`);
    for (const lane of ['exec', 'coo', 'cpo', 'developer', 'external-read']) {
      assert.equal(roleAllows(rule!.role, lane), false, `${tool} must reject ${lane}`);
    }
  }
  for (const tool of [...HEYGEN_DATA_TOOLS, ...HEYGEN_PREFLIGHT_TOOLS]) {
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
  const base = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
  const production = readFileSync(new URL('./production-tools.ts', import.meta.url), 'utf8');
  const look = readFileSync(new URL('./look-tools.ts', import.meta.url), 'utf8');
  const future = readFileSync(new URL('./future-tools.ts', import.meta.url), 'utf8');
  const directSource = `${base}\n${production}\n${look}`;
  const directRegistrations = (directSource.match(/registerTool\(/g) ?? []).length;
  const futureDefinitions = (future.match(/name: 'heygen_[a-z0-9_]+'/g) ?? []).length;
  const gates = (directSource.match(/if \(!isHeyGenToolAllowed\(/g) ?? []).length;
  const refusals = (base.match(/return heyGenLaneRefusal\(/g) ?? []).length;
  const productionRefusals = (production.match(/return laneRefusal\(/g) ?? []).length;
  const lookRefusals = (look.match(/return refusal\(/g) ?? []).length;
  assert.equal(directRegistrations, 36, 'direct public HeyGen registrations must remain fixed');
  assert.equal(futureDefinitions, 10, 'future surface must remain exactly nine preflight-only contracts plus one bounded metadata update');
  assert.equal(directRegistrations + futureDefinitions, 46, 'complete HeyGen surface count must be exact');
  assert.equal(gates + lookRefusals, directRegistrations, 'every direct registerTool call-site must explicitly check its caller lane');
  assert.equal(refusals + productionRefusals + lookRefusals, directRegistrations, 'every direct explicit gate must return a lane refusal');
  assert.match(future, /if \(!\(HEYGEN_DATA_LANES as readonly string\[\]\)\.includes\(ctx\.callerAgent\)\)/);
});

test('public HeyGen surface is fixed and exposes only bounded direct video while excluding generic/destructive capabilities', () => {
  assert.deepEqual([...HEYGEN_DATA_TOOLS], [
    'heygen_account_get',
    'heygen_diagnostics_get',
    'heygen_videos_list',
    'heygen_video_get',
    'heygen_video_agent_styles_list',
    'heygen_avatar_groups_list',
    'heygen_avatar_group_get',
    'heygen_avatar_looks_list',
    'heygen_avatar_look_get',
    'heygen_voices_list',
    'heygen_voice_design',
    'heygen_video_statuses_get',
    'heygen_video_agent_sessions_list',
    'heygen_video_agent_session_get',
    'heygen_video_agent_session_videos_list',
    'heygen_video_agent_resource_get',
    'heygen_asset_get',
    'heygen_asset_statuses_get',
    'heygen_brand_kits_list',
    'heygen_brand_glossaries_list',
    'heygen_brand_glossary_get',
    'heygen_voice_get',
    'heygen_translation_languages_list',
    'heygen_translations_list',
    'heygen_translation_get',
    'heygen_translation_statuses_get',
    'heygen_proofread_get',
    'heygen_avatar_video_operation_get',
    'heygen_reference_look_operation_get',
  ]);
  assert.deepEqual([...HEYGEN_CREATION_TOOLS], [
    'heygen_prompt_avatar_create',
    'heygen_avatar_video_create',
    'heygen_existing_video_ingest_qa',
    'heygen_video_wait_ingest_qa',
  ]);
  const exposed = [...HEYGEN_PAIRING_TOOLS, ...HEYGEN_DATA_TOOLS, ...HEYGEN_METADATA_TOOLS, ...HEYGEN_PREFLIGHT_TOOLS, ...HEYGEN_CREATION_TOOLS];
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

  const baseSource = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
  const productionSource = readFileSync(new URL('./production-tools.ts', import.meta.url), 'utf8');
  const lookSource = readFileSync(new URL('./look-tools.ts', import.meta.url), 'utf8');
  assert.match(lookSource, /name: 'heygen_reference_look_create',[\s\S]*?category: 'write_orchestrated'/);
  assert.match(lookSource, /reference_asset_ids:[\s\S]*?max\(3\)/);
  const promptStart = baseSource.indexOf("name: 'heygen_prompt_avatar_create'");
  const promptEnd = baseSource.indexOf('registerHeyGenProductionTools', promptStart);
  const promptBlock = baseSource.slice(promptStart, promptEnd);
  assert.match(promptBlock, /category: 'write_simple'/);
  assert.doesNotMatch(promptBlock, /category: 'write_orchestrated'/);
  assert.match(promptBlock, /isHeyGenProviderWriteEnabled\('ENABLE_HEYGEN_PROMPT_AVATAR_WRITES'\)/);
  assert.match(productionSource, /name: 'heygen_avatar_video_create',[\s\S]*?category: 'write_orchestrated'/);
  assert.match(productionSource, /isHeyGenProviderWriteEnabled\('ENABLE_HEYGEN_AVATAR_VIDEO_WRITES'\)/);
  assert.match(lookSource, /isHeyGenProviderWriteEnabled\('ENABLE_HEYGEN_REFERENCE_LOOK_WRITES'\)/);
  assert.match(productionSource, /name: 'heygen_existing_video_ingest_qa',[\s\S]*?category: 'write_orchestrated'/);
  assert.match(productionSource, /name: 'heygen_video_wait_ingest_qa',[\s\S]*?category: 'write_orchestrated'/);
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
  const lookLog = redactHeyGenReferenceLookInputForLog({
    operation_id: 'look_op_01',
    idempotency_key: 'SENSITIVE-LOOK-IDEMPOTENCY-KEY',
    source_avatar_id: 'look_1',
    destination_group_id: 'group_1',
    name: 'SENSITIVE LOOK NAME',
    prompt,
    reference_asset_ids: ['asset_1'],
    confirmed_billing_snapshot_sha256: 'a'.repeat(64),
    confirmed_billing_state_sha256: 'b'.repeat(64),
    confirmed_billing_observed_at: '2026-08-10T00:00:00Z',
    confirmed_premium_credits_before: 591,
    reserve_premium_credits: 100,
    owner_approval_jws: 'SENSITIVE-JWS',
    confirm_credit_use: true,
  });
  const videoLog = redactHeyGenAvatarVideoInputForLog({
    operation_id: 'video_op_01',
    idempotency_key: 'SENSITIVE-IDEMPOTENCY-KEY',
    manifest_sha256: 'a'.repeat(64),
    title: 'SENSITIVE TITLE',
    avatar_id: 'look_1',
    voice_id: 'voice_1',
    script: prompt,
    engine: 'avatar_v',
    resolution: '1080p',
    aspect_ratio: '16:9',
    confirm_credit_use: true,
    confirmed_premium_credits_before: 981,
    confirmed_billing_snapshot_sha256: 'c'.repeat(64),
    confirmed_billing_state_sha256: 'd'.repeat(64),
    confirmed_billing_observed_at: '2026-08-10T00:00:00Z',
    owner_approval_jws: 'SENSITIVE-JWS',
    max_approved_credits: 20,
    reserve_premium_credits: 300,
  });
  for (const payload of [createLog, voiceLog, lookLog, videoLog]) {
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(prompt), false);
    assert.equal(serialized.includes('SENSITIVE-IDEMPOTENCY-KEY'), false);
    assert.equal(serialized.includes('SENSITIVE TITLE'), false);
    assert.equal(serialized.includes('SENSITIVE LOOK NAME'), false);
    assert.equal(serialized.includes('SENSITIVE-JWS'), false);
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
  assert.deepEqual(Object.keys(lookLog as Record<string, unknown>).sort(), [
    'confirm_credit_use',
    'confirmed_billing_observed_at',
    'confirmed_billing_snapshot_sha256',
    'confirmed_billing_state_sha256',
    'confirmed_premium_credits_before',
    'destination_group_id',
    'idempotency_key_sha256',
    'name_sha256',
    'operation_id',
    'owner_approval_jws_present',
    'prompt_sha256',
    'reference_asset_count',
    'reserve_premium_credits',
    'source_avatar_id',
  ]);
  assert.deepEqual(Object.keys(videoLog as Record<string, unknown>).sort(), [
    'aspect_ratio',
    'avatar_id',
    'confirm_credit_use',
    'confirmed_billing_observed_at',
    'confirmed_billing_snapshot_sha256',
    'confirmed_billing_state_sha256',
    'confirmed_premium_credits_before',
    'engine',
    'idempotency_key_sha256',
    'manifest_sha256',
    'max_approved_credits',
    'operation_id',
    'owner_approval_jws_present',
    'reserve_premium_credits',
    'resolution',
    'script_sha256',
    'title_sha256',
    'voice_id',
  ]);
  assert.equal((createLog as Record<string, unknown>).confirm_credit_use, true);
  assert.equal((createLog as Record<string, unknown>).confirmed_premium_credits_before, 7);

  const registrySource = readFileSync(new URL('../registry.ts', import.meta.url), 'utf8');
  assert.match(registrySource, /input: def\.redactInputForLog/);
  assert.match(registrySource, /args: def\.redactInputForLog/);
  assert.match(registrySource, /def\.shieldInputForScan\(handlerInput\)/);
  assert.match(registrySource, /z\.union\(\[strictResultSchema, jitStubSchema\]\)/);
});

test('connector curation includes every exact HeyGen tool only in the CTO ship set', () => {
  const source = readFileSync(new URL('../registry.ts', import.meta.url), 'utf8');
  const shipStart = source.indexOf('export const CTO_SHIP_LANE_TOOLSET');
  const externalStart = source.indexOf('export const EXTERNAL_READONLY_TOOLSET');
  const externalEnd = source.indexOf('export function isShipLane', externalStart);
  assert.ok(shipStart >= 0 && externalStart > shipStart && externalEnd > externalStart);
  const ship = source.slice(shipStart, externalStart);
  const external = source.slice(externalStart, externalEnd);
  for (const tool of [...HEYGEN_PAIRING_TOOLS, ...HEYGEN_DATA_TOOLS, ...HEYGEN_METADATA_TOOLS, ...HEYGEN_PREFLIGHT_TOOLS, ...HEYGEN_CREATION_TOOLS]) {
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

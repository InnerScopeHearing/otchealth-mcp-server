import { createHash } from 'node:crypto';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Safe structured-log/journal projection for semantic voice-search prompts. */
export function redactHeyGenVoiceDesignInputForLog(input: Record<string, unknown>): unknown {
  return {
    prompt_sha256: sha256(String(input.prompt ?? '')),
    gender: typeof input.gender === 'string' ? input.gender : undefined,
    locale: typeof input.locale === 'string' ? input.locale : undefined,
    seed: typeof input.seed === 'number' ? input.seed : undefined,
  };
}

/** Safe structured-log/journal projection for credit-consuming prompt-avatar creation. */
export function redactHeyGenAvatarVideoInputForLog(input: Record<string, unknown>): unknown {
  return {
    operation_id: typeof input.operation_id === 'string' ? input.operation_id : '(invalid)',
    idempotency_key_sha256: sha256(String(input.idempotency_key ?? '')),
    manifest_sha256: typeof input.manifest_sha256 === 'string' ? input.manifest_sha256 : undefined,
    title_sha256: sha256(String(input.title ?? '')),
    avatar_id: typeof input.avatar_id === 'string' ? input.avatar_id : undefined,
    voice_id: typeof input.voice_id === 'string' ? input.voice_id : undefined,
    script_sha256: sha256(String(input.script ?? '')),
    engine: typeof input.engine === 'string' ? input.engine : undefined,
    production_profile: typeof input.production_profile === 'string' ? input.production_profile : undefined,
    family_story_founder: typeof input.family_story_founder === 'string' ? input.family_story_founder : undefined,
    reference_look_id_present: typeof input.reference_look_id === 'string',
    resolution: typeof input.resolution === 'string' ? input.resolution : undefined,
    aspect_ratio: typeof input.aspect_ratio === 'string' ? input.aspect_ratio : undefined,
    confirm_credit_use: input.confirm_credit_use === true,
    confirmed_premium_credits_before:
      typeof input.confirmed_premium_credits_before === 'number'
        ? input.confirmed_premium_credits_before
        : undefined,
    confirmed_billing_snapshot_sha256:
      typeof input.confirmed_billing_snapshot_sha256 === 'string'
        ? input.confirmed_billing_snapshot_sha256
        : undefined,
    confirmed_billing_state_sha256:
      typeof input.confirmed_billing_state_sha256 === 'string'
        ? input.confirmed_billing_state_sha256
        : undefined,
    confirmed_billing_observed_at:
      typeof input.confirmed_billing_observed_at === 'string'
        ? input.confirmed_billing_observed_at
        : undefined,
    owner_approval_jws_present: typeof input.owner_approval_jws === 'string',
    max_approved_credits:
      typeof input.max_approved_credits === 'number' ? input.max_approved_credits : undefined,
    reserve_premium_credits:
      typeof input.reserve_premium_credits === 'number' ? input.reserve_premium_credits : undefined,
  };
}

export function redactHeyGenReferenceLookInputForLog(input: Record<string, unknown>): unknown {
  return {
    operation_id: typeof input.operation_id === 'string' ? input.operation_id : '(invalid)',
    idempotency_key_sha256: sha256(String(input.idempotency_key ?? '')),
    source_avatar_id: typeof input.source_avatar_id === 'string' ? input.source_avatar_id : undefined,
    destination_group_id: typeof input.destination_group_id === 'string' ? input.destination_group_id : undefined,
    name_sha256: sha256(String(input.name ?? '')),
    prompt_sha256: sha256(String(input.prompt ?? '')),
    reference_asset_count: Array.isArray(input.reference_asset_ids) ? input.reference_asset_ids.length : 0,
    confirmed_billing_snapshot_sha256:
      typeof input.confirmed_billing_snapshot_sha256 === 'string'
        ? input.confirmed_billing_snapshot_sha256
        : undefined,
    confirmed_billing_state_sha256:
      typeof input.confirmed_billing_state_sha256 === 'string'
        ? input.confirmed_billing_state_sha256
        : undefined,
    confirmed_billing_observed_at:
      typeof input.confirmed_billing_observed_at === 'string'
        ? input.confirmed_billing_observed_at
        : undefined,
    confirmed_premium_credits_before:
      typeof input.confirmed_premium_credits_before === 'number'
        ? input.confirmed_premium_credits_before
        : undefined,
    reserve_premium_credits:
      typeof input.reserve_premium_credits === 'number' ? input.reserve_premium_credits : undefined,
    owner_approval_jws_present: typeof input.owner_approval_jws === 'string',
    confirm_credit_use: input.confirm_credit_use === true,
  };
}

export function redactHeyGenPromptAvatarInputForLog(input: Record<string, unknown>): unknown {
  return {
    name: typeof input.name === 'string' ? input.name : '(invalid)',
    prompt_sha256: sha256(String(input.prompt ?? '')),
    avatar_group_id: typeof input.avatar_group_id === 'string' ? input.avatar_group_id : undefined,
    confirm_credit_use: input.confirm_credit_use === true,
    confirmed_premium_credits_before:
      typeof input.confirmed_premium_credits_before === 'number'
        ? input.confirmed_premium_credits_before
        : undefined,
  };
}

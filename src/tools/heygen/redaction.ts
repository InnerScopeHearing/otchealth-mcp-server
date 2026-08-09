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

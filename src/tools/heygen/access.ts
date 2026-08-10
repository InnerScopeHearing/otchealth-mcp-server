export const HEYGEN_DATA_LANES = ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'] as const;
export const HEYGEN_PAIRING_TOOLS = ['heygen_pairing_start', 'heygen_pairing_status'] as const;
export const HEYGEN_DATA_TOOLS = [
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
  'heygen_owner_approval_status_get',
  'heygen_reference_look_operation_get',
] as const;
export const HEYGEN_CREATION_TOOLS = [
  'heygen_prompt_avatar_create',
  'heygen_avatar_video_create',
  'heygen_existing_video_ingest_qa',
  'heygen_video_wait_ingest_qa',
] as const;

/** Owner-delegated fixed CRO lane: direct video + private QA only; pairing/prompt-avatar stay CTO-only. */
export const HEYGEN_CRO_DIRECT_TOOLS = [
  'heygen_avatar_video_create',
  'heygen_existing_video_ingest_qa',
  'heygen_video_wait_ingest_qa',
] as const;
export const HEYGEN_METADATA_TOOLS = [
  'heygen_avatar_look_name_update',
] as const;
export const HEYGEN_PREFLIGHT_TOOLS = [
  'heygen_reference_look_create',
  'heygen_video_agent_session_create_preflight',
  'heygen_video_agent_feedback_send_preflight',
  'heygen_video_agent_generation_approve_preflight',
  'heygen_video_agent_session_stop_preflight',
  'heygen_asset_upload_preflight',
  'heygen_translation_create_preflight',
  'heygen_proofread_create_preflight',
  'heygen_proofread_generate_preflight',
  'heygen_speech_preview_create_preflight',
] as const;

export type HeyGenToolName =
  | (typeof HEYGEN_PAIRING_TOOLS)[number]
  | (typeof HEYGEN_DATA_TOOLS)[number]
  | (typeof HEYGEN_METADATA_TOOLS)[number]
  | (typeof HEYGEN_CREATION_TOOLS)[number]
  | (typeof HEYGEN_PREFLIGHT_TOOLS)[number];

/** Exact in-handler authorization model. Unknown/external lanes always fail closed. */
export function isHeyGenToolAllowed(toolName: HeyGenToolName, caller: string | undefined | null): boolean {
  if (!caller) return false;
  if (
    (HEYGEN_PAIRING_TOOLS as readonly string[]).includes(toolName) ||
    toolName === 'heygen_prompt_avatar_create'
  ) {
    return caller === 'cto';
  }
  if ((HEYGEN_CRO_DIRECT_TOOLS as readonly string[]).includes(toolName)) {
    return caller === 'cto' || caller === 'cro';
  }
  return (HEYGEN_DATA_LANES as readonly string[]).includes(caller);
}

export const HEYGEN_DATA_LANES = ['cto', 'exec', 'coo', 'cro', 'cpo', 'developer'] as const;
export const HEYGEN_PAIRING_TOOLS = ['heygen_pairing_start', 'heygen_pairing_status'] as const;
export const HEYGEN_DATA_TOOLS = [
  'heygen_account_get',
  'heygen_videos_list',
  'heygen_video_get',
  'heygen_video_agent_styles_list',
] as const;

export type HeyGenToolName =
  | (typeof HEYGEN_PAIRING_TOOLS)[number]
  | (typeof HEYGEN_DATA_TOOLS)[number];

/** Exact in-handler authorization model. Unknown/external lanes always fail closed. */
export function isHeyGenToolAllowed(toolName: HeyGenToolName, caller: string | undefined | null): boolean {
  if (!caller) return false;
  if ((HEYGEN_PAIRING_TOOLS as readonly string[]).includes(toolName)) return caller === 'cto';
  return (HEYGEN_DATA_LANES as readonly string[]).includes(caller);
}

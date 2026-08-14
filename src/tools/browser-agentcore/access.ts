export const BROWSER_AGENTCORE_ALLOWED_LANES = ['cto', 'wefunder-campaign-director'] as const;
export const BROWSER_AGENTCORE_PROFILE_LABEL = 'wefunder_campaign_director';
export type BrowserAgentcoreToolName = 'browser_agentcore_wefunder_preflight' | 'browser_agentcore_wefunder_inspect_public';

/** Unknown callers fail closed. Wefunder Campaign Director is read-only-only. */
export function isBrowserAgentcoreCallerAllowed(caller: string | undefined | null): boolean {
  return !!caller && (BROWSER_AGENTCORE_ALLOWED_LANES as readonly string[]).includes(caller);
}

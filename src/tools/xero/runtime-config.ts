/** Xero's isolated source worker needs only Xero configuration, not gateway integrations. */
const XERO_KEYS = [
  'XERO_CLIENT_ID', 'XERO_CLIENT_SECRET',
  'XERO_RT_OTCHEALTH', 'XERO_RT_INND', 'XERO_RT_HEARINGASSIST', 'XERO_RT_PERSONAL',
  'XERO_TENANT_OTCHEALTH', 'XERO_TENANT_INND', 'XERO_TENANT_HEARINGASSIST', 'XERO_TENANT_PERSONAL',
] as const;
export type XeroRuntimeConfig = Readonly<Record<(typeof XERO_KEYS)[number], string>>;
export function loadXeroRuntimeConfig(env: NodeJS.ProcessEnv = process.env): XeroRuntimeConfig {
  return Object.freeze(Object.fromEntries(XERO_KEYS.map(key => [key, env[key] ?? ''])) as Record<(typeof XERO_KEYS)[number], string>);
}

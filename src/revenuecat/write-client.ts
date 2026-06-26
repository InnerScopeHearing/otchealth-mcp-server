import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

export class RevenueCatWriteError extends Error {
  readonly code: string; readonly status: number; readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message); this.name = 'RevenueCatWriteError'; this.code = a.code; this.status = a.status; this.nextStep = a.nextStep;
  }
}

function requireKey(): string {
  if (!env.REVENUECAT_API_KEY) throw new RevenueCatWriteError({ code: 'revenuecat_not_configured', status: 0, message: 'REVENUECAT_API_KEY not set.', nextStep: 'Add REVENUECAT_API_KEY (sk_) from the vault.' });
  return env.REVENUECAT_API_KEY;
}

// RevenueCat subscriber-attribute writes use the v1 REST API (POST /v1/subscribers/{app_user_id}/attributes).
// Entitlement grant/revoke use v2: POST /v2/projects/{project_id}/subscribers/{subscriber_id}/entitlements/{entitlement_id}/actions/grant_promotional
//   and /actions/revoke_promotional.
// Auth: Authorization: Bearer <sk_...> for all requests.

async function rcPostV1<T = any>(path: string, body: unknown): Promise<T> {
  const key = requireKey();
  const { statusCode, body: resBody } = await request(`https://api.revenuecat.com/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resBody.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new RevenueCatWriteError({ code: `revenuecat_${statusCode}`, status: statusCode, message: data?.message || data?.error || `HTTP ${statusCode}`, nextStep: 'Verify REVENUECAT_API_KEY (sk_) and app_user_id.' });
  return data as T;
}

async function rcPostV2<T = any>(path: string, body: unknown): Promise<T> {
  const key = requireKey();
  const { statusCode, body: resBody } = await request(`https://api.revenuecat.com/v2${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resBody.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new RevenueCatWriteError({ code: `revenuecat_${statusCode}`, status: statusCode, message: data?.message || data?.error || `HTTP ${statusCode}`, nextStep: 'Verify REVENUECAT_API_KEY (sk_), project_id, subscriber_id, and entitlement_id.' });
  return data as T;
}

// --- Write operations ---

/**
 * Subscriber attributes are key/value pairs. Each attribute value has a mandatory "value" field
 * and an optional "updated_at_ms" timestamp. The RC v1 POST /subscribers/{id}/attributes endpoint
 * accepts: { attributes: { "<key>": { value: string, updated_at_ms?: number } } }
 */
export interface SubscriberAttribute {
  value: string;
  updated_at_ms?: number;
}

export interface SetSubscriberAttributesParams {
  app_user_id: string;
  attributes: Record<string, SubscriberAttribute>;
}

export async function setSubscriberAttributes(params: SetSubscriberAttributesParams): Promise<any> {
  // Returns 200 with empty body on success.
  return rcPostV1(`/subscribers/${encodeURIComponent(params.app_user_id)}/attributes`, {
    attributes: params.attributes,
  });
}

export interface GrantEntitlementParams {
  project_id: string;
  subscriber_id: string;
  entitlement_id: string;
  /** Duration of the promotional entitlement. One of: daily, weekly, monthly, two_month, three_month, six_month, yearly, lifetime */
  duration: 'daily' | 'weekly' | 'monthly' | 'two_month' | 'three_month' | 'six_month' | 'yearly' | 'lifetime';
  /** Optional start time in ms since epoch. Defaults to now. */
  start_time_ms?: number;
}

export async function grantEntitlement(params: GrantEntitlementParams): Promise<any> {
  const body: Record<string, unknown> = { duration: params.duration };
  if (params.start_time_ms !== undefined) body.start_time_ms = params.start_time_ms;
  return rcPostV2(
    `/projects/${encodeURIComponent(params.project_id)}/subscribers/${encodeURIComponent(params.subscriber_id)}/entitlements/${encodeURIComponent(params.entitlement_id)}/actions/grant_promotional`,
    body,
  );
}

export interface RevokeEntitlementParams {
  project_id: string;
  subscriber_id: string;
  entitlement_id: string;
}

export async function revokeEntitlement(params: RevokeEntitlementParams): Promise<any> {
  return rcPostV2(
    `/projects/${encodeURIComponent(params.project_id)}/subscribers/${encodeURIComponent(params.subscriber_id)}/entitlements/${encodeURIComponent(params.entitlement_id)}/actions/revoke_promotional`,
    {},
  );
}

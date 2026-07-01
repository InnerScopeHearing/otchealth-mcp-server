/**
 * RevenueCat full-client.ts — self-contained, exhaustive API client
 * Covers: v2 REST API for projects, customers, entitlements, offerings,
 * packages, products, apps, invoices, and v1 subscriber/receipt endpoints.
 * Auth: Bearer <REVENUECAT_API_KEY> (sk_...)
 */
import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

export class RevenueCatFullError extends Error {
  readonly code: string; readonly status: number; readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message);
    this.name = 'RevenueCatFullError';
    this.code = a.code;
    this.status = a.status;
    this.nextStep = a.nextStep;
  }
}

function requireKey(): string {
  if (!env.REVENUECAT_API_KEY) throw new RevenueCatFullError({
    code: 'revenuecat_not_configured', status: 0,
    message: 'REVENUECAT_API_KEY not set.',
    nextStep: 'Add REVENUECAT_API_KEY (sk_) from the vault.',
  });
  return env.REVENUECAT_API_KEY;
}

function handleError(statusCode: number, data: any, context: string): never {
  throw new RevenueCatFullError({
    code: `revenuecat_${statusCode}`,
    status: statusCode,
    message: data?.message || data?.error || `HTTP ${statusCode}`,
    nextStep: `Verify REVENUECAT_API_KEY and ${context}.`,
  });
}

async function rcRequest<T = any>(
  method: string,
  path: string,
  body?: unknown,
  version: 'v1' | 'v2' = 'v2',
): Promise<T> {
  const key = requireKey();
  const url = `https://api.revenuecat.com/${version}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  let reqBody: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    reqBody = JSON.stringify(body);
  }
  // GET is read-only (retries:1); POST/DELETE mutate customers/entitlements/offerings/
  // packages/products/invoices/purchases, so retries:0 to avoid a duplicate mutation on
  // a timeout.
  const retries = method === 'GET' ? 1 : 0;
  const res = await fetchWithBudget(url, { method, headers, body: reqBody }, { retries });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) handleError(statusCode, data, path);
  return data as T;
}

// Convenience wrappers
const get = <T = any>(path: string, v: 'v1' | 'v2' = 'v2') => rcRequest<T>('GET', path, undefined, v);
const post = <T = any>(path: string, body: unknown, v: 'v1' | 'v2' = 'v2') => rcRequest<T>('POST', path, body, v);
const del = <T = any>(path: string, v: 'v1' | 'v2' = 'v2') => rcRequest<T>('DELETE', path, undefined, v);

// ─────────────────────────────────────────────────────────────────────────────
// PROJECTS
// ─────────────────────────────────────────────────────────────────────────────
export async function getProject(project_id: string): Promise<any> {
  return get(`/projects/${encodeURIComponent(project_id)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// APPS
// ─────────────────────────────────────────────────────────────────────────────
export async function listApps(project_id: string, params?: { starting_after?: string; limit?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.starting_after) qs.set('starting_after', params.starting_after);
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString() ? `?${qs}` : '';
  return get(`/projects/${encodeURIComponent(project_id)}/apps${q}`);
}

export async function getApp(project_id: string, app_id: string): Promise<any> {
  return get(`/projects/${encodeURIComponent(project_id)}/apps/${encodeURIComponent(app_id)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMERS (v2 subscribers)
// ─────────────────────────────────────────────────────────────────────────────
export async function getCustomer(project_id: string, customer_id: string): Promise<any> {
  return get(`/projects/${encodeURIComponent(project_id)}/customers/${encodeURIComponent(customer_id)}`);
}

export async function listCustomers(project_id: string, params?: { starting_after?: string; limit?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.starting_after) qs.set('starting_after', params.starting_after);
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString() ? `?${qs}` : '';
  return get(`/projects/${encodeURIComponent(project_id)}/customers${q}`);
}

export async function createCustomer(project_id: string, params: { app_user_id: string; [k: string]: any }): Promise<any> {
  return post(`/projects/${encodeURIComponent(project_id)}/customers`, params);
}

export async function deleteCustomer(project_id: string, customer_id: string): Promise<any> {
  return del(`/projects/${encodeURIComponent(project_id)}/customers/${encodeURIComponent(customer_id)}`);
}

export async function getCustomerSubscriptions(project_id: string, customer_id: string, params?: { starting_after?: string; limit?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.starting_after) qs.set('starting_after', params.starting_after);
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString() ? `?${qs}` : '';
  return get(`/projects/${encodeURIComponent(project_id)}/customers/${encodeURIComponent(customer_id)}/subscriptions${q}`);
}

export async function getCustomerPurchases(project_id: string, customer_id: string, params?: { starting_after?: string; limit?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.starting_after) qs.set('starting_after', params.starting_after);
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString() ? `?${qs}` : '';
  return get(`/projects/${encodeURIComponent(project_id)}/customers/${encodeURIComponent(customer_id)}/purchases${q}`);
}

export async function getCustomerActiveEntitlements(project_id: string, customer_id: string, params?: { starting_after?: string; limit?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.starting_after) qs.set('starting_after', params.starting_after);
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString() ? `?${qs}` : '';
  return get(`/projects/${encodeURIComponent(project_id)}/customers/${encodeURIComponent(customer_id)}/active_entitlements${q}`);
}

export async function getCustomerAttributes(project_id: string, customer_id: string): Promise<any> {
  return get(`/projects/${encodeURIComponent(project_id)}/customers/${encodeURIComponent(customer_id)}/attributes`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTITLEMENTS
// ─────────────────────────────────────────────────────────────────────────────
export async function listEntitlements(project_id: string, params?: { starting_after?: string; limit?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.starting_after) qs.set('starting_after', params.starting_after);
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString() ? `?${qs}` : '';
  return get(`/projects/${encodeURIComponent(project_id)}/entitlements${q}`);
}

export async function getEntitlement(project_id: string, entitlement_id: string): Promise<any> {
  return get(`/projects/${encodeURIComponent(project_id)}/entitlements/${encodeURIComponent(entitlement_id)}`);
}

export async function createEntitlement(project_id: string, params: { lookup_key: string; display_name?: string; [k: string]: any }): Promise<any> {
  return post(`/projects/${encodeURIComponent(project_id)}/entitlements`, params);
}

export async function updateEntitlement(project_id: string, entitlement_id: string, params: { display_name?: string; [k: string]: any }): Promise<any> {
  return post(`/projects/${encodeURIComponent(project_id)}/entitlements/${encodeURIComponent(entitlement_id)}`, params);
}

export async function deleteEntitlement(project_id: string, entitlement_id: string): Promise<any> {
  return del(`/projects/${encodeURIComponent(project_id)}/entitlements/${encodeURIComponent(entitlement_id)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// OFFERINGS
// ─────────────────────────────────────────────────────────────────────────────
export async function listOfferings(project_id: string, params?: { starting_after?: string; limit?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.starting_after) qs.set('starting_after', params.starting_after);
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString() ? `?${qs}` : '';
  return get(`/projects/${encodeURIComponent(project_id)}/offerings${q}`);
}

export async function getOffering(project_id: string, offering_id: string): Promise<any> {
  return get(`/projects/${encodeURIComponent(project_id)}/offerings/${encodeURIComponent(offering_id)}`);
}

export async function createOffering(project_id: string, params: { lookup_key: string; display_name?: string; [k: string]: any }): Promise<any> {
  return post(`/projects/${encodeURIComponent(project_id)}/offerings`, params);
}

export async function updateOffering(project_id: string, offering_id: string, params: { display_name?: string; is_current?: boolean; [k: string]: any }): Promise<any> {
  return post(`/projects/${encodeURIComponent(project_id)}/offerings/${encodeURIComponent(offering_id)}`, params);
}

export async function deleteOffering(project_id: string, offering_id: string): Promise<any> {
  return del(`/projects/${encodeURIComponent(project_id)}/offerings/${encodeURIComponent(offering_id)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PACKAGES
// ─────────────────────────────────────────────────────────────────────────────
export async function listPackages(project_id: string, offering_id: string, params?: { starting_after?: string; limit?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.starting_after) qs.set('starting_after', params.starting_after);
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString() ? `?${qs}` : '';
  return get(`/projects/${encodeURIComponent(project_id)}/offerings/${encodeURIComponent(offering_id)}/packages${q}`);
}

export async function getPackage(project_id: string, offering_id: string, package_id: string): Promise<any> {
  return get(`/projects/${encodeURIComponent(project_id)}/offerings/${encodeURIComponent(offering_id)}/packages/${encodeURIComponent(package_id)}`);
}

export async function createPackage(project_id: string, offering_id: string, params: { lookup_key: string; display_name?: string; position?: number; [k: string]: any }): Promise<any> {
  return post(`/projects/${encodeURIComponent(project_id)}/offerings/${encodeURIComponent(offering_id)}/packages`, params);
}

export async function updatePackage(project_id: string, offering_id: string, package_id: string, params: { display_name?: string; position?: number; [k: string]: any }): Promise<any> {
  return post(`/projects/${encodeURIComponent(project_id)}/offerings/${encodeURIComponent(offering_id)}/packages/${encodeURIComponent(package_id)}`, params);
}

export async function deletePackage(project_id: string, offering_id: string, package_id: string): Promise<any> {
  return del(`/projects/${encodeURIComponent(project_id)}/offerings/${encodeURIComponent(offering_id)}/packages/${encodeURIComponent(package_id)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTS
// ─────────────────────────────────────────────────────────────────────────────
export async function listProducts(project_id: string, params?: { starting_after?: string; limit?: number; app_id?: string }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.starting_after) qs.set('starting_after', params.starting_after);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.app_id) qs.set('app_id', params.app_id);
  const q = qs.toString() ? `?${qs}` : '';
  return get(`/projects/${encodeURIComponent(project_id)}/products${q}`);
}

export async function getProduct(project_id: string, product_id: string): Promise<any> {
  return get(`/projects/${encodeURIComponent(project_id)}/products/${encodeURIComponent(product_id)}`);
}

export async function createProduct(project_id: string, params: { store_identifier: string; app_id: string; type?: string; [k: string]: any }): Promise<any> {
  return post(`/projects/${encodeURIComponent(project_id)}/products`, params);
}

export async function updateProduct(project_id: string, product_id: string, params: { display_name?: string; [k: string]: any }): Promise<any> {
  return post(`/projects/${encodeURIComponent(project_id)}/products/${encodeURIComponent(product_id)}`, params);
}

export async function deleteProduct(project_id: string, product_id: string): Promise<any> {
  return del(`/projects/${encodeURIComponent(project_id)}/products/${encodeURIComponent(product_id)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// INVOICES / CUSTOMER INVOICES
// ─────────────────────────────────────────────────────────────────────────────
export async function listCustomerInvoices(project_id: string, customer_id: string, params?: { starting_after?: string; limit?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.starting_after) qs.set('starting_after', params.starting_after);
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString() ? `?${qs}` : '';
  return get(`/projects/${encodeURIComponent(project_id)}/customers/${encodeURIComponent(customer_id)}/invoices${q}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// V1 SUBSCRIBER (legacy read + refund/defer actions)
// ─────────────────────────────────────────────────────────────────────────────
export async function getSubscriberV1(app_user_id: string): Promise<any> {
  return get(`/subscribers/${encodeURIComponent(app_user_id)}`, 'v1');
}

export async function revokeGooglePurchase(app_user_id: string, product_id: string, token: string): Promise<any> {
  return post(`/subscribers/${encodeURIComponent(app_user_id)}/subscriptions/${encodeURIComponent(product_id)}/revoke`, { token }, 'v1');
}

export async function revokeApplePurchase(app_user_id: string, product_id: string): Promise<any> {
  return post(`/subscribers/${encodeURIComponent(app_user_id)}/subscriptions/${encodeURIComponent(product_id)}/revoke`, {}, 'v1');
}

export async function deferGooglePurchase(app_user_id: string, product_id: string, params: { expiry_time_ms: number; token: string }): Promise<any> {
  return post(`/subscribers/${encodeURIComponent(app_user_id)}/subscriptions/${encodeURIComponent(product_id)}/defer`, params, 'v1');
}

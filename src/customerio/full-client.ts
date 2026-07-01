/**
 * Customer.io Full Client — exhaustive coverage of App API + Track API.
 *
 * Auth:
 *   App API  → Bearer token (CIO_APP_API_BEARER)
 *   Track API → HTTP Basic (CIO_SITE_ID:CIO_TRACK_KEY)
 *
 * Ring-safety: any identifier / name containing "medreview" (case-insensitive)
 * is refused before the network call — PHI project writes are blocked at the gateway.
 *
 * Do NOT import from write-client.ts or app-api-client.ts to avoid circular deps;
 * this file is fully self-contained.
 */

import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { CustomerIoApiError } from './app-api-client.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

const APP_BASE = 'https://api.customer.io/v1';
const TRACK_BASE = 'https://track.customer.io/api/v1';

// ── Auth helpers ──────────────────────────────────────────────────────────────

function appBearer(): string {
  return `Bearer ${env.CIO_APP_API_BEARER}`;
}

function trackBasic(): string {
  const raw = `${env.CIO_SITE_ID}:${env.CIO_TRACK_KEY}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

// ── Ring-safety guard ─────────────────────────────────────────────────────────

export function guardMedreview(label: string, value: string): void {
  if (/medreview/i.test(value)) {
    throw new CustomerIoApiError({
      code: 'cio_phi_write_blocked',
      status: 403,
      message: `Write refused: "${label}" contains "medreview" — PHI project writes are blocked at the gateway level.`,
      nextStep:
        'MedReview project data must never be written via the MCP gateway. ' +
        'If this is legitimate, perform the operation directly in the Customer.io UI with appropriate PHI controls.',
    });
  }
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

function buildQuery(q?: Record<string, string | number | boolean | undefined>): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

function mapAppError(status: number, path: string, body: string): CustomerIoApiError {
  let up: unknown = body;
  try { up = JSON.parse(body); } catch { /**/ }
  if (status === 401 || status === 403)
    return new CustomerIoApiError({ code: 'cio_auth_failed', status, message: `Customer.io App API rejected auth on ${path}.`, nextStep: 'Confirm CIO_APP_API_BEARER in the Notion Token Vault.', upstream: up });
  if (status === 404)
    return new CustomerIoApiError({ code: 'cio_not_found', status, message: `Customer.io App API returned 404 for ${path}.`, nextStep: `Verify the ID exists at https://fly.customer.io/env/${env.CIO_WORKSPACE_ID}/`, upstream: up });
  if (status === 400)
    return new CustomerIoApiError({ code: 'cio_bad_request', status, message: `Customer.io App API rejected request to ${path}.`, nextStep: 'Check required fields and parameter types.', upstream: up });
  if (status === 429)
    return new CustomerIoApiError({ code: 'cio_rate_limited', status, message: `Customer.io App API rate-limited ${path}.`, nextStep: 'Back off 30-60 s and retry.', upstream: up });
  if (status >= 500)
    return new CustomerIoApiError({ code: 'cio_upstream_error', status, message: `Customer.io App API returned ${status} for ${path}.`, nextStep: 'Check https://status.customer.io/ and retry.', upstream: up });
  return new CustomerIoApiError({ code: 'cio_request_error', status, message: `Customer.io App API returned ${status} for ${path}.`, nextStep: 'Verify input parameters match the App API docs.', upstream: up });
}

function mapTrackError(status: number, method: string, path: string, body: string): CustomerIoApiError {
  let up: unknown = body;
  try { up = JSON.parse(body); } catch { /**/ }
  if (status === 401 || status === 403)
    return new CustomerIoApiError({ code: 'cio_auth_failed', status, message: `Customer.io Track API rejected basic auth on ${method} ${path}.`, nextStep: 'Confirm CIO_SITE_ID + CIO_TRACK_KEY match the Notion vault.', upstream: up });
  if (status === 400)
    return new CustomerIoApiError({ code: 'cio_bad_request', status, message: `Customer.io Track API rejected ${method} ${path} as malformed.`, nextStep: 'Verify identifier, payload shape, and required fields.', upstream: up });
  if (status === 404)
    return new CustomerIoApiError({ code: 'cio_not_found', status, message: `Customer.io Track API returned 404 for ${method} ${path}.`, nextStep: 'Verify the customer identifier exists in this workspace.', upstream: up });
  if (status === 429)
    return new CustomerIoApiError({ code: 'cio_rate_limited', status, message: 'Customer.io Track API rate-limited the call.', nextStep: 'Back off 30-60 s and retry.', upstream: up });
  if (status >= 500)
    return new CustomerIoApiError({ code: 'cio_upstream_error', status, message: `Customer.io Track API returned ${status} for ${method} ${path}.`, nextStep: 'Check https://status.customer.io/ and retry.', upstream: up });
  return new CustomerIoApiError({ code: 'cio_request_error', status, message: `Customer.io Track API returned ${status} for ${method} ${path}.`, nextStep: 'Check the Track API docs for this endpoint.', upstream: up });
}

async function appGet<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>, correlationId?: string): Promise<T> {
  const url = `${APP_BASE}${path}${buildQuery(query)}`;
  const started = Date.now();
  try {
    // Read-only GET: safe to retry once on a network blip / 429 / 5xx.
    const res = await fetchWithBudget(url, {
      method: 'GET',
      headers: { authorization: appBearer(), accept: 'application/json' },
    }, { timeoutMs: 30_000, retries: 1 });
    const body = await res.text();
    const latency = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      logger.debug({ type: 'cio_full_app_get_ok', path, status: res.status, latency_ms: latency, correlation_id: correlationId }, 'cio full-client app GET ok');
      return body ? (JSON.parse(body) as T) : ({} as T);
    }
    throw mapAppError(res.status, path, body);
  } catch (err) {
    if (err instanceof CustomerIoApiError) throw err;
    throw new CustomerIoApiError({ code: 'cio_network_error', status: 0, message: `Network error GET ${path}: ${(err as Error).message}`, nextStep: 'Check Railway logs and Customer.io status page.', upstream: err });
  }
}

async function appWrite<T = unknown>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, correlationId?: string): Promise<T> {
  const url = `${APP_BASE}${path}`;
  const started = Date.now();
  try {
    // Non-idempotent by default (create/update/delete newsletters, segments,
    // collections, snippets, exports; also used for searchCustomers, a read-shaped
    // POST): retries:0 so a timeout never causes a duplicate mutation.
    const res = await fetchWithBudget(url, {
      method,
      headers: { authorization: appBearer(), 'content-type': 'application/json', accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, { timeoutMs: 30_000, retries: 0 });
    const raw = await res.text();
    const latency = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      logger.debug({ type: 'cio_full_app_write_ok', method, path, status: res.status, latency_ms: latency, correlation_id: correlationId }, 'cio full-client app write ok');
      return raw ? (JSON.parse(raw) as T) : ({} as T);
    }
    throw mapAppError(res.status, path, raw);
  } catch (err) {
    if (err instanceof CustomerIoApiError) throw err;
    throw new CustomerIoApiError({ code: 'cio_network_error', status: 0, message: `Network error ${method} ${path}: ${(err as Error).message}`, nextStep: 'Check Railway logs and Customer.io status page.', upstream: err });
  }
}

async function trackWrite(method: 'PUT' | 'POST' | 'DELETE' | 'PATCH', path: string, body?: unknown, correlationId?: string): Promise<unknown> {
  const url = `${TRACK_BASE}${path}`;
  const started = Date.now();
  try {
    // Non-idempotent write (create/update/delete objects, relationships, devices,
    // merge customers): retries:0 so a timeout never causes a duplicate mutation.
    const res = await fetchWithBudget(url, {
      method,
      headers: { authorization: trackBasic(), 'content-type': 'application/json', accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, { timeoutMs: 30_000, retries: 0 });
    const raw = await res.text();
    const latency = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      logger.debug({ type: 'cio_full_track_write_ok', method, path, status: res.status, latency_ms: latency, correlation_id: correlationId }, 'cio full-client track write ok');
      return raw ? safeJson(raw) : { ok: true };
    }
    throw mapTrackError(res.status, method, path, raw);
  } catch (err) {
    if (err instanceof CustomerIoApiError) throw err;
    throw new CustomerIoApiError({ code: 'cio_network_error', status: 0, message: `Network error ${method} ${path}: ${(err as Error).message}`, nextStep: 'Check Railway logs and Customer.io status page.', upstream: err });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CAMPAIGNS (App API)
// ═════════════════════════════════════════════════════════════════════════════

export async function listCampaigns(args: {
  limit?: number;
  start_after?: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet('/campaigns', { limit: args.limit, start_after: args.start_after }, args.correlationId);
}

export async function getCampaign(args: { campaign_id: number; correlationId?: string }): Promise<unknown> {
  return appGet(`/campaigns/${args.campaign_id}`, undefined, args.correlationId);
}

export async function getCampaignMetrics(args: {
  campaign_id: number;
  period?: string;
  steps?: number;
  start?: number;
  end?: number;
  type?: string;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/campaigns/${args.campaign_id}/metrics`, {
    period: args.period,
    steps: args.steps,
    start: args.start,
    end: args.end,
    type: args.type,
  }, args.correlationId);
}

export async function getCampaignActions(args: { campaign_id: number; correlationId?: string }): Promise<unknown> {
  return appGet(`/campaigns/${args.campaign_id}/actions`, undefined, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// BROADCASTS (App API) — list, get, get-metrics, get-status, errors
// ═════════════════════════════════════════════════════════════════════════════

export async function listBroadcasts(args: {
  limit?: number;
  start_after?: number;
  correlationId?: string;
}): Promise<unknown> {
  // Broadcasts in Customer.io are accessible via /newsletters with type=broadcast
  return appGet('/newsletters', { limit: args.limit, start_after: args.start_after }, args.correlationId);
}

export async function getBroadcast(args: { broadcast_id: number; correlationId?: string }): Promise<unknown> {
  return appGet(`/newsletters/${args.broadcast_id}`, undefined, args.correlationId);
}

export async function getBroadcastMetrics(args: {
  broadcast_id: number;
  period?: string;
  steps?: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/newsletters/${args.broadcast_id}/metrics`, {
    period: args.period,
    steps: args.steps,
  }, args.correlationId);
}

export async function getBroadcastStatus(args: {
  broadcast_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/campaigns/${args.broadcast_id}/triggers`, undefined, args.correlationId);
}

export async function getBroadcastErrors(args: {
  broadcast_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/newsletters/${args.broadcast_id}/metrics/errors`, undefined, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// NEWSLETTERS (App API)
// ═════════════════════════════════════════════════════════════════════════════

export interface CreateNewsletterArgs {
  name: string;
  subject: string;
  from_id?: number;
  reply_to_id?: number;
  type?: string;
  correlationId?: string;
}

export async function createNewsletter(args: CreateNewsletterArgs): Promise<unknown> {
  guardMedreview('name', args.name);
  const { correlationId, ...body } = args;
  return appWrite('POST', '/newsletters', body, correlationId);
}

export async function listNewsletterVariants(args: {
  newsletter_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/newsletters/${args.newsletter_id}/contents`, undefined, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// SEGMENTS (App API)
// ═════════════════════════════════════════════════════════════════════════════

export async function listSegments(args: {
  limit?: number;
  start_after?: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet('/segments', { limit: args.limit, start_after: args.start_after }, args.correlationId);
}

export interface CreateSegmentArgs {
  name: string;
  description?: string;
  type?: 'manual' | 'behavioral' | 'data';
  correlationId?: string;
}

export async function createSegment(args: CreateSegmentArgs): Promise<unknown> {
  guardMedreview('name', args.name);
  const { correlationId, ...body } = args;
  return appWrite('POST', '/segments', body, correlationId);
}

export async function deleteSegment(args: {
  segment_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appWrite('DELETE', `/segments/${args.segment_id}`, undefined, args.correlationId);
}

export async function addCustomersToSegment(args: {
  segment_id: number;
  ids: string[];
  correlationId?: string;
}): Promise<unknown> {
  for (const id of args.ids) guardMedreview('customer_id', id);
  return appWrite('POST', `/segments/${args.segment_id}/membership`, { ids: args.ids }, args.correlationId);
}

export async function removeCustomersFromSegment(args: {
  segment_id: number;
  ids: string[];
  correlationId?: string;
}): Promise<unknown> {
  return appWrite('DELETE', `/segments/${args.segment_id}/membership`, { ids: args.ids }, args.correlationId);
}

export async function getSegmentMembershipCount(args: {
  segment_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/segments/${args.segment_id}/customer_count`, undefined, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMERS (App API) — search, get-attributes, get-segments, get-messages, get-activities
// ═════════════════════════════════════════════════════════════════════════════

export async function searchCustomers(args: {
  filter: Record<string, unknown>;
  limit?: number;
  start?: string;
  correlationId?: string;
}): Promise<unknown> {
  const body: Record<string, unknown> = { filter: args.filter };
  if (args.limit !== undefined) body.limit = args.limit;
  if (args.start !== undefined) body.start = args.start;
  return appWrite('POST', '/customers', body, args.correlationId);
}

export async function getCustomerAttributes(args: {
  customer_id: string;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/customers/${encodeURIComponent(args.customer_id)}/attributes`, undefined, args.correlationId);
}

export async function getCustomerSegments(args: {
  customer_id: string;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/customers/${encodeURIComponent(args.customer_id)}/segments`, undefined, args.correlationId);
}

export async function getCustomerMessages(args: {
  customer_id: string;
  limit?: number;
  start?: string;
  type?: string;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/customers/${encodeURIComponent(args.customer_id)}/messages`, {
    limit: args.limit,
    start: args.start,
    type: args.type,
  }, args.correlationId);
}

export async function getCustomerActivities(args: {
  customer_id: string;
  limit?: number;
  start?: string;
  type?: string;
  name?: string;
  deleted?: boolean;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/customers/${encodeURIComponent(args.customer_id)}/activities`, {
    limit: args.limit,
    start: args.start,
    type: args.type,
    name: args.name,
    deleted: args.deleted,
  }, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTIVITIES (App API)
// ═════════════════════════════════════════════════════════════════════════════

export async function listActivities(args: {
  limit?: number;
  start?: string;
  type?: string;
  name?: string;
  deleted?: boolean;
  created_before?: number;
  created_after?: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet('/activities', {
    limit: args.limit,
    start: args.start,
    type: args.type,
    name: args.name,
    deleted: args.deleted,
    created_before: args.created_before,
    created_after: args.created_after,
  }, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// MESSAGES (App API)
// ═════════════════════════════════════════════════════════════════════════════

export async function listMessages(args: {
  limit?: number;
  start?: string;
  type?: string;
  campaign_id?: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet('/messages', {
    limit: args.limit,
    start: args.start,
    type: args.type,
    campaign_id: args.campaign_id,
  }, args.correlationId);
}

export async function getMessage(args: {
  message_id: string;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/messages/${encodeURIComponent(args.message_id)}`, undefined, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// TRANSACTIONAL MESSAGES (App API)
// ═════════════════════════════════════════════════════════════════════════════

export async function listTransactionalMessages(args: {
  limit?: number;
  start_after?: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet('/transactional', { limit: args.limit, start_after: args.start_after }, args.correlationId);
}

export async function getTransactionalMessage(args: {
  transactional_message_id: number | string;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/transactional/${args.transactional_message_id}`, undefined, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTS (App API)
// ═════════════════════════════════════════════════════════════════════════════

export interface CreateCustomersExportArgs {
  segment_id?: number;
  filter?: Record<string, unknown>;
  fields?: string[];
  correlationId?: string;
}

export async function createCustomersExport(args: CreateCustomersExportArgs): Promise<unknown> {
  const { correlationId, ...body } = args;
  return appWrite('POST', '/exports/customers', body, correlationId);
}

export interface CreateDeliveriesExportArgs {
  campaign_id?: number;
  newsletter_id?: number;
  type?: string;
  start?: number;
  end?: number;
  fields?: string[];
  correlationId?: string;
}

export async function createDeliveriesExport(args: CreateDeliveriesExportArgs): Promise<unknown> {
  const { correlationId, ...body } = args;
  return appWrite('POST', '/exports/deliveries', body, correlationId);
}

export async function getExport(args: {
  export_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/exports/${args.export_id}`, undefined, args.correlationId);
}

export async function downloadExport(args: {
  export_id: number;
  correlationId?: string;
}): Promise<unknown> {
  // Returns the download URL for the export file
  return appGet(`/exports/${args.export_id}/download`, undefined, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// COLLECTIONS (App API)
// ═════════════════════════════════════════════════════════════════════════════

export async function listCollections(args: { correlationId?: string }): Promise<unknown> {
  return appGet('/collections', undefined, args.correlationId);
}

export async function getCollection(args: {
  collection_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/collections/${args.collection_id}`, undefined, args.correlationId);
}

export interface CreateCollectionArgs {
  name: string;
  data: Record<string, unknown>[];
  correlationId?: string;
}

export async function createCollection(args: CreateCollectionArgs): Promise<unknown> {
  guardMedreview('name', args.name);
  const { correlationId, ...body } = args;
  return appWrite('POST', '/collections', body, correlationId);
}

export interface UpdateCollectionArgs {
  collection_id: number;
  name?: string;
  data?: Record<string, unknown>[];
  correlationId?: string;
}

export async function updateCollection(args: UpdateCollectionArgs): Promise<unknown> {
  if (args.name) guardMedreview('name', args.name);
  const { collection_id, correlationId, ...body } = args;
  return appWrite('PUT', `/collections/${collection_id}`, body, correlationId);
}

export async function deleteCollection(args: {
  collection_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appWrite('DELETE', `/collections/${args.collection_id}`, undefined, args.correlationId);
}

export async function getCollectionContent(args: {
  collection_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/collections/${args.collection_id}/content`, undefined, args.correlationId);
}

export interface UpdateCollectionContentArgs {
  collection_id: number;
  data: Record<string, unknown>[];
  correlationId?: string;
}

export async function updateCollectionContent(args: UpdateCollectionContentArgs): Promise<unknown> {
  return appWrite('PUT', `/collections/${args.collection_id}/content`, { data: args.data }, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// SNIPPETS (App API)
// ═════════════════════════════════════════════════════════════════════════════

export async function listSnippets(args: { correlationId?: string }): Promise<unknown> {
  return appGet('/snippets', undefined, args.correlationId);
}

export async function getSnippet(args: {
  snippet_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/snippets/${args.snippet_id}`, undefined, args.correlationId);
}

export interface CreateSnippetArgs {
  name: string;
  value: string;
  correlationId?: string;
}

export async function createSnippet(args: CreateSnippetArgs): Promise<unknown> {
  guardMedreview('name', args.name);
  const { correlationId, ...body } = args;
  return appWrite('POST', '/snippets', body, correlationId);
}

export interface UpdateSnippetArgs {
  snippet_id: number;
  name?: string;
  value?: string;
  correlationId?: string;
}

export async function updateSnippet(args: UpdateSnippetArgs): Promise<unknown> {
  if (args.name) guardMedreview('name', args.name);
  const { snippet_id, correlationId, ...body } = args;
  return appWrite('PUT', `/snippets/${snippet_id}`, body, correlationId);
}

export async function deleteSnippet(args: {
  snippet_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appWrite('DELETE', `/snippets/${args.snippet_id}`, undefined, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// REPORTING WEBHOOKS (App API)
// ═════════════════════════════════════════════════════════════════════════════

export async function listReportingWebhooks(args: { correlationId?: string }): Promise<unknown> {
  return appGet('/reporting_webhooks', undefined, args.correlationId);
}

export async function getReportingWebhook(args: {
  webhook_id: number;
  correlationId?: string;
}): Promise<unknown> {
  return appGet(`/reporting_webhooks/${args.webhook_id}`, undefined, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// OBJECTS + RELATIONSHIPS (Track API)
// ═════════════════════════════════════════════════════════════════════════════

export interface CreateOrUpdateObjectArgs {
  object_type_id: number;
  object_id: string;
  attributes?: Record<string, unknown>;
  correlationId?: string;
}

export async function createOrUpdateObject(args: CreateOrUpdateObjectArgs): Promise<unknown> {
  guardMedreview('object_id', args.object_id);
  const { object_type_id, object_id, attributes, correlationId } = args;
  const path = `/objects/${object_type_id}/${encodeURIComponent(object_id)}`;
  return trackWrite('PUT', path, attributes ?? {}, correlationId);
}

export async function deleteObject(args: {
  object_type_id: number;
  object_id: string;
  correlationId?: string;
}): Promise<unknown> {
  const path = `/objects/${args.object_type_id}/${encodeURIComponent(args.object_id)}`;
  return trackWrite('DELETE', path, undefined, args.correlationId);
}

export interface AddRelationshipsArgs {
  object_type_id: number;
  object_id: string;
  relationships: Array<{ identifiers: Record<string, string> }>;
  correlationId?: string;
}

export async function addRelationships(args: AddRelationshipsArgs): Promise<unknown> {
  guardMedreview('object_id', args.object_id);
  const path = `/objects/${args.object_type_id}/${encodeURIComponent(args.object_id)}/relationships`;
  return trackWrite('POST', path, { relationships: args.relationships }, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// DEVICES (Track API)
// ═════════════════════════════════════════════════════════════════════════════

export interface AddDeviceArgs {
  customer_id: string;
  device_id: string;
  platform: 'ios' | 'android';
  attributes?: Record<string, unknown>;
  correlationId?: string;
}

export async function addDevice(args: AddDeviceArgs): Promise<unknown> {
  guardMedreview('customer_id', args.customer_id);
  const path = `/customers/${encodeURIComponent(args.customer_id)}/devices`;
  const body: Record<string, unknown> = { device: { id: args.device_id, platform: args.platform } };
  if (args.attributes) (body.device as Record<string, unknown>).attributes = args.attributes;
  return trackWrite('PUT', path, body, args.correlationId);
}

export async function deleteDevice(args: {
  customer_id: string;
  device_id: string;
  correlationId?: string;
}): Promise<unknown> {
  guardMedreview('customer_id', args.customer_id);
  const path = `/customers/${encodeURIComponent(args.customer_id)}/devices/${encodeURIComponent(args.device_id)}`;
  return trackWrite('DELETE', path, undefined, args.correlationId);
}

// ═════════════════════════════════════════════════════════════════════════════
// MERGE CUSTOMERS (Track API)
// ═════════════════════════════════════════════════════════════════════════════

export interface MergeCustomersArgs {
  primary_id_type: 'email' | 'id' | 'cio_id';
  primary_id: string;
  secondary_id_type: 'email' | 'id' | 'cio_id';
  secondary_id: string;
  correlationId?: string;
}

export async function mergeCustomers(args: MergeCustomersArgs): Promise<unknown> {
  guardMedreview('primary_id', args.primary_id);
  guardMedreview('secondary_id', args.secondary_id);
  const body = {
    primary: { [args.primary_id_type]: args.primary_id },
    secondary: { [args.secondary_id_type]: args.secondary_id },
  };
  return trackWrite('POST', '/merge_customers', body, args.correlationId);
}

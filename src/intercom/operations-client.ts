import { fetchWithBudget, type FetchBudgetOptions } from '../util/fetch-budget.js';
import {
  getOperation,
  validateOperationRequest,
  type OperationInput,
  type IntercomOperation,
} from './operations-contract.js';

export interface OperationResult { status: number; data: unknown }
export interface OperationsClientOptions {
  baseUrl?: string;
  accessToken?: string;
  finAccessToken?: string;
  timeoutMs?: number;
  fetcher?: (url: string | URL, init?: RequestInit, options?: FetchBudgetOptions) => Promise<Response>;
}

export class IntercomOperationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'IntercomOperationError';
    this.code = code;
    this.status = status;
  }
}

const regionHosts = new Map([
  ['https://api.intercom.io', 'https://api.intercom.io'],
  ['https://api.eu.intercom.io', 'https://api.eu.intercom.io'],
  ['https://api.au.intercom.io', 'https://api.au.intercom.io'],
]);
const DEFAULT_BASE_URL = 'https://api.intercom.io';
const MAX_TIMEOUT_MS = 30_000;
const INTERCOM_VERSION = '2.17';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_URL_LENGTH = 16 * 1024;

function normalizedBase(value: string | undefined): string {
  const candidate = (value ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fixed = regionHosts.get(candidate);
  if (!fixed) throw new IntercomOperationError('invalid_region', 0, 'Intercom region is not supported.');
  return fixed;
}

function pathFor(operation: IntercomOperation, pathParams: Record<string, string> = {}): string {
  return operation.path.replace(/\{([^}]+)\}/g, (_placeholder, key: string) => {
    const value = pathParams[key];
    if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[^A-Za-z0-9._~-]/.test(value)) {
      throw new IntercomOperationError('invalid_path_parameter', 0, 'Intercom path parameter is invalid.');
    }
    return encodeURIComponent(value);
  });
}

function appendQuery(search: URLSearchParams, operation: IntercomOperation, query: Record<string, unknown> = {}): void {
  for (const parameter of operation.parameters.filter((entry) => entry.in === 'query')) {
    if (!(parameter.name in query)) continue;
    const value = query[parameter.name];
    if (Array.isArray(value)) {
      if (!value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
        throw new IntercomOperationError('invalid_query_parameter', 0, 'Intercom query parameter is invalid.');
      }
      const explode = parameter.explode ?? parameter.style === 'form';
      if (explode) for (const item of value) search.append(parameter.name, String(item));
      else search.append(parameter.name, value.map(String).join(','));
    } else if (['string', 'number', 'boolean'].includes(typeof value)) {
      search.append(parameter.name, String(value));
    } else {
      throw new IntercomOperationError('invalid_query_parameter', 0, 'Intercom query parameter is invalid.');
    }
  }
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new IntercomOperationError('provider_response_too_large', 0, 'Intercom response exceeded the 1 MiB limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function parsedBody(bytes: Uint8Array, contentType: string, expectedTypes: string[], status: number): unknown {
  if (!bytes.byteLength) return {};
  const received = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const mediaType = received || (expectedTypes.length === 1 ? expectedTypes[0].toLowerCase() : '');
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
    catch { throw new IntercomOperationError('invalid_provider_response', status, 'Intercom returned an invalid response.'); }
  }
  if (mediaType.startsWith('text/')) return new TextDecoder().decode(bytes);
  return { content_type: mediaType || 'application/octet-stream', data_base64: Buffer.from(bytes).toString('base64') };
}

export function createIntercomOperationsClient(options: OperationsClientOptions = {}): { executeOperation(input: OperationInput): Promise<OperationResult> } {
  const base = normalizedBase(options.baseUrl ?? process.env.INTERCOM_API_BASE_URL);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new IntercomOperationError('invalid_timeout', 0, 'Intercom timeout is invalid.');
  }
  const fetcher = options.fetcher ?? fetchWithBudget;
  return {
    async executeOperation(input: OperationInput): Promise<OperationResult> {
      const validation = validateOperationRequest(input);
      if (!validation.valid) throw new IntercomOperationError('invalid_operation_request', 0, 'Intercom operation request is invalid.');
      const operation = getOperation(input.operation_id);
      if (!operation) throw new IntercomOperationError('unknown_operation', 0, 'Intercom operation is unavailable.');
      const token = operation.domain === 'fin_runtime'
        ? options.finAccessToken ?? process.env.INTERCOM_FIN_ACCESS_TOKEN ?? options.accessToken ?? process.env.INTERCOM_ACCESS_TOKEN
        : options.accessToken ?? process.env.INTERCOM_ACCESS_TOKEN;
      if (!token) throw new IntercomOperationError('auth_not_configured', 0, 'Intercom credentials are not configured.');

      const path = pathFor(operation, input.path_params);
      const url = new URL(`${base}${path}`);
      appendQuery(url.searchParams, operation, input.query);
      if (url.href.length > MAX_URL_LENGTH) throw new IntercomOperationError('request_too_large', 0, 'Intercom request exceeded the URL size limit.');
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'intercom-version': INTERCOM_VERSION,
      };
      let body: string | undefined;
      if (input.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(input.body);
        if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
          throw new IntercomOperationError('request_too_large', 0, 'Intercom request exceeded the 1 MiB body limit.');
        }
      }
      try {
        const response = await fetcher(url, { method: operation.method, headers, body, redirect: 'error' }, {
          timeoutMs,
          retries: operation.effect === 'read' ? 1 : 0,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new IntercomOperationError('provider_rejected_request', response.status, `Intercom returned HTTP ${response.status}.`);
        }
        const bytes = await responseBytes(response);
        return {
          status: response.status,
          data: parsedBody(bytes, response.headers.get('content-type') ?? '', operation.response_content_types, response.status),
        };
      } catch (error) {
        if (error instanceof IntercomOperationError) throw error;
        // Do not propagate fetch errors: implementations can embed request URLs or headers.
        throw new IntercomOperationError('transport_failed', 0, 'Intercom request failed.');
      }
    },
  };
}

const defaultClient = createIntercomOperationsClient();
export const executeOperation = (input: OperationInput): Promise<OperationResult> => defaultClient.executeOperation(input);

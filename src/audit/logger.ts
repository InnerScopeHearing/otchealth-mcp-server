import pino, { type Logger } from 'pino';
import { randomUUID, createHash } from 'node:crypto';
import { loadEnv } from '../config/env.js';

function fallbackNodeEnv(v: string | undefined): 'development' | 'production' | 'test' {
  if (v === 'development' || v === 'production' || v === 'test') return v;
  return 'production';
}

function fallbackLogLevel(v: string | undefined): 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' {
  if (v === 'trace' || v === 'debug' || v === 'info' || v === 'warn' || v === 'error' || v === 'fatal') return v;
  return 'info';
}

function loggerConfig(): { NODE_ENV: 'development' | 'production' | 'test'; LOG_LEVEL: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' } {
  try {
    const env = loadEnv();
    return { NODE_ENV: env.NODE_ENV, LOG_LEVEL: env.LOG_LEVEL };
  } catch {
    return {
      NODE_ENV: fallbackNodeEnv(process.env.NODE_ENV),
      LOG_LEVEL: fallbackLogLevel(process.env.LOG_LEVEL),
    };
  }
}

const env = loggerConfig();

const redactPaths = [
  'authorization',
  'req.headers.authorization',
  'request.headers.authorization',
  'req.headers["x-heygen-oauth-credentials"]',
  'request.headers["x-heygen-oauth-credentials"]',
  '*.password',
  '*.token',
  '*.api_key',
  '*.apiKey',
  '*.bearer',
  '*.secret',
  'CIO_APP_API_BEARER',
  'CIO_TRACK_KEY',
  'CIO_FLY_SERVICE_ACCOUNT_TOKEN',
  'PERPLEXITY_CONNECTOR_TOKEN',
  'ADMIN_REVOKE_TOKEN',
  'N8N_API_KEY',
  'N8N_WEBHOOK_SECRET',
];

const base = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: 'otchealth-mcp', env: env.NODE_ENV },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});

export const logger: Logger = base;

export function newCorrelationId(): string {
  return randomUUID();
}

export function hashToken(token: string): string {
  // This fingerprints a high-entropy bearer token for audit correlation; it does not hash a password.
  // codeql[js/insufficient-password-hash]
  return createHash('sha256').update(token).digest('hex');
}

const PII_EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@/g;
const PII_PHONE = /\+?\d{7,}/g;

export function maskPii<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(PII_EMAIL, '$1***@')
      .replace(PII_PHONE, '[phone]') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskPii(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = maskPii(v);
    }
    return out as T;
  }
  return value;
}

export interface ToolCallLogStart {
  correlation_id: string;
  tool: string;
  caller_hash: string;
  input: unknown;
  dry_run?: boolean;
  read_only_mode: boolean;
}

export interface ToolCallLogEnd {
  correlation_id: string;
  tool: string;
  caller_hash: string;
  outcome: 'success' | 'error' | 'rejected';
  latency_ms: number;
  /** Explicit non-negative result count only; arbitrary result payloads are never logged. */
  result_count?: number;
  status_code?: number;
  error_code?: string;
  /** @deprecated Accepted for caller compatibility; never serialized by the logger. */
  before?: unknown;
  /** @deprecated Accepted for caller compatibility; never serialized by the logger. */
  after?: unknown;
  /** @deprecated Accepted for caller compatibility; never serialized by the logger. */
  error_message?: string;
}

function inputFieldCount(input: unknown): number {
  if (Array.isArray(input)) return input.length;
  if (input && typeof input === 'object') return Object.keys(input).length;
  return 0;
}

/** Content-minimized structured start fields, exported for synthetic privacy tests. */
export function toolCallStartLogFields(entry: ToolCallLogStart): Record<string, unknown> {
  return {
    type: 'tool_call_start',
    correlation_id: entry.correlation_id,
    tool: entry.tool,
    caller_hash: entry.caller_hash,
    input_field_count: inputFieldCount(entry.input),
    dry_run: entry.dry_run ?? false,
    read_only_mode: entry.read_only_mode,
  };
}

/** Content-minimized structured end fields, exported for synthetic privacy tests. */
export function toolCallEndLogFields(entry: ToolCallLogEnd): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: 'tool_call_end',
    correlation_id: entry.correlation_id,
    tool: entry.tool,
    caller_hash: entry.caller_hash,
    outcome: entry.outcome,
    latency_ms: entry.latency_ms,
  };
  if (Number.isInteger(entry.result_count) && entry.result_count! >= 0) payload.result_count = entry.result_count;
  if (Number.isInteger(entry.status_code) && entry.status_code! >= 100 && entry.status_code! <= 599) payload.status_code = entry.status_code;
  if (entry.error_code) payload.error_code = entry.error_code;
  return payload;
}

export function logToolStart(entry: ToolCallLogStart): void {
  logger.info(toolCallStartLogFields(entry), `tool_start ${entry.tool}`);
}

export function logToolEnd(entry: ToolCallLogEnd): void {
  logger.info(toolCallEndLogFields(entry), `tool_end ${entry.tool} ${entry.outcome}`);
}


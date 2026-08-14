import { createHash, createHmac } from 'node:crypto';
import type { RedactedReceipt } from './policy.js';

export interface AgentCoreBrowserTransport {
  inspect(targets: URL[], maxSeconds: number): Promise<RedactedReceipt[]>;
}

export class AgentCoreBrowserTransportError extends Error {
  readonly code: string;
  readonly nextStep: string;
  constructor(code: string, message: string, nextStep: string) {
    super(message);
    this.name = 'AgentCoreBrowserTransportError';
    this.code = code;
    this.nextStep = nextStep;
  }
}

export interface AgentCoreRuntimeConfig {
  enabled: boolean;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/**
 * Credentials are injected into the runtime from Azure Key Vault as local Container Apps secrets.
 * This module never reads Key Vault directly and never serializes credentials, browser profiles,
 * CDP endpoints, HTML, screenshots, cookies, or session identifiers.
 */
export function agentCoreRuntimeConfig(env: Record<string, string | undefined> = process.env): AgentCoreRuntimeConfig {
  return {
    enabled: env.ENABLE_AGENTCORE_WEFUNDER_PUBLIC_READONLY === 'true',
    region: env.AWS_REGION || 'us-east-1',
    accessKeyId: env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY || '',
    sessionToken: env.AWS_SESSION_TOKEN || '',
  };
}

export function assertAgentCoreConfigured(config = agentCoreRuntimeConfig()): void {
  if (!config.enabled) {
    throw new AgentCoreBrowserTransportError('provider_disabled', 'AgentCore public-read-only provider is disabled.', 'Keep ENABLE_AGENTCORE_WEFUNDER_PUBLIC_READONLY=false until the reviewed deployment binds the dedicated runtime identity.');
  }
  if (!config.accessKeyId || !config.secretAccessKey) {
    throw new AgentCoreBrowserTransportError('provider_unconfigured', 'AgentCore runtime credentials are not configured.', 'Bind the dedicated least-privilege AWS runtime credentials from Azure Key Vault to the gateway Container App; do not place values in source or logs.');
  }
}

function hmac(key: Buffer | string, value: string): Buffer { return createHmac('sha256', key).update(value, 'utf8').digest(); }

/** Exported for deterministic unit tests; no request is sent here. */
export function signAgentCoreListBrowsers(config: Required<Pick<AgentCoreRuntimeConfig, 'region' | 'accessKeyId' | 'secretAccessKey'>> & Pick<AgentCoreRuntimeConfig, 'sessionToken'>, now = new Date()): Record<string, string> {
  const service = 'bedrock-agentcore';
  const host = `${service}.${config.region}.amazonaws.com`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').replace('Z', 'Z');
  const day = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update('').digest('hex');
  const headers: Record<string, string> = { host, 'x-amz-date': amzDate };
  if (config.sessionToken) headers['x-amz-security-token'] = config.sessionToken;
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join('');
  const canonicalRequest = `GET\n/browsers\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${day}/${config.region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const kDate = hmac(`AWS4${config.secretAccessKey}`, day);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, service);
  const signingKey = hmac(kService, 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign).toString('hex')}`;
  return headers;
}

/**
 * Deliberately inert transport. AgentCore Browser API/session creation is not guessed from an
 * endpoint preflight: a deployment must first verify the current AWS API contract, IAM action set,
 * budget, CloudTrail retention, and runtime profile lifecycle. This protects against accidentally
 * creating a billable browser/profile while trying to inspect a public page.
 */
export class UnconfiguredAgentCoreBrowserTransport implements AgentCoreBrowserTransport {
  async inspect(_targets: URL[], _maxSeconds: number): Promise<RedactedReceipt[]> {
    throw new AgentCoreBrowserTransportError('runtime_adapter_unconfigured', 'AgentCore policy passed, but the session transport is intentionally not configured.', 'Complete the reviewed transport deployment before enabling public inspection; no browser session was created.');
  }
}

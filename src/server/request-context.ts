import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  callerHash: string;
  correlationId: string;
  callerAgent: string;
  /** True for Claude Chat (DCR) connector requests -> advertise a curated toolset, not the full catalog. */
  connectorSurface?: boolean;
  /**
   * True for M365 declarative-agent static-token requests (see auth/bearer.ts's m365_static_auth).
   * Used by tools/registry.ts to skip JIT result-offloading for these callers -- see bearer.ts's
   * AuthContext.m365_static_auth doc comment for why.
   */
  m365StaticAuth?: boolean;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentCallerHash(): string {
  return requestContext.getStore()?.callerHash ?? 'unknown';
}

export function currentCorrelationId(): string {
  return requestContext.getStore()?.correlationId ?? 'unknown';
}

/** The agent identity derived from the caller's OAuth token (per-agent client), or '' if unknown. */
export function currentCallerAgent(): string {
  return requestContext.getStore()?.callerAgent ?? '';
}

/** True when the current request is a Claude Chat (DCR) connector — gets the curated toolset. */
export function isConnectorSurface(): boolean {
  return requestContext.getStore()?.connectorSurface === true;
}

/** True when the current request authenticated via an M365 declarative-agent static token. */
export function isM365StaticAuth(): boolean {
  return requestContext.getStore()?.m365StaticAuth === true;
}

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  callerHash: string;
  correlationId: string;
  callerAgent: string;
  /** True for Claude Chat (DCR) connector requests -> advertise a curated toolset, not the full catalog. */
  connectorSurface?: boolean;
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

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  callerHash: string;
  correlationId: string;
  callerAgent: string;
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

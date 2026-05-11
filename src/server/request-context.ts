import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  callerHash: string;
  correlationId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentCallerHash(): string {
  return requestContext.getStore()?.callerHash ?? 'unknown';
}

export function currentCorrelationId(): string {
  return requestContext.getStore()?.correlationId ?? 'unknown';
}

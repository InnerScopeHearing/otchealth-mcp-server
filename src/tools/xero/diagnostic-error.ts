export type XeroHttpErrorStage = 'refresh' | 'connections' | 'accounting_get';

/** HTTP metadata retained for safe telemetry; the legacy message remains available to callers. */
export class XeroHttpError extends Error {
  readonly status: number;
  readonly stage: XeroHttpErrorStage;

  constructor(stage: XeroHttpErrorStage, status: number, message: string) {
    super(message);
    this.name = 'XeroHttpError';
    this.status = status;
    this.stage = stage;
  }
}

/** Closed, content-free projection for Xero tool timing. */
export function projectXeroFailure(err: unknown, canonicalName: string): string | null {
  if (!canonicalName.startsWith('xero_') || !(err instanceof XeroHttpError)) return null;
  const { status } = err;
  if (!Number.isInteger(status) || status < 100 || status > 599) return null;
  if (status >= 200 && status < 300) return null;
  if (status === 401) return 'xero_http_unauthorized';
  if (status === 403) return 'xero_http_forbidden';
  if (status === 429) return 'xero_http_rate_limited';
  if (status >= 500) return 'xero_http_upstream_error';
  return 'xero_http_request_error';
}

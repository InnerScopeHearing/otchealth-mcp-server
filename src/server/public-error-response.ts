export type PublicErrorResponse = Readonly<{
  statusCode: 429 | 500;
  body: Readonly<{ error: 'rate_limited' | 'internal_error'; message: string }>;
}>;

/** Keeps rate limiting actionable without exposing Fastify's internal error details. */
export function publicErrorResponse(error: unknown): PublicErrorResponse {
  if (typeof error === 'object' && error !== null &&
      (error as { statusCode?: unknown }).statusCode === 429) {
    return {
      statusCode: 429,
      body: { error: 'rate_limited', message: 'Too many requests. Retry later.' },
    };
  }
  return {
    statusCode: 500,
    body: { error: 'internal_error', message: 'Unexpected server error. Check logs for details.' },
  };
}

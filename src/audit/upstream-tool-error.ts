/** Error metadata only. Never forward provider response bodies or credential text. */
const INTERCOM_NEXT_STEPS: ReadonlyMap<string, string> = new Map([
  ['intercom_not_configured', 'Check the protected Intercom credential configuration; never disclose credential values.'],
  ['intercom_invalid_path_segment', 'Use a valid resource ID returned by an authorized Intercom read.'],
  ['intercom_auth_failed', 'Check the connected Intercom workspace and granted API permissions; never disclose credential values.'],
  ['intercom_not_found', 'Verify the resource ID in the intended Intercom workspace.'],
  ['intercom_validation_error', 'Check required fields and constraints against the configured Intercom API version.'],
  ['intercom_rate_limited', 'Honor the provider retry interval; reconcile any uncertain write before retrying.'],
  ['intercom_request_error', 'Check request fields against the configured Intercom API version; reconcile any uncertain write before retrying.'],
  ['intercom_upstream_error', 'Check Intercom service availability; reconcile any uncertain write before retrying.'],
]);

export function parseUpstreamToolError(err: unknown, canonicalName: string): { code: string; nextStep: string; status?: number } | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = err as Record<string, unknown>;
  if (typeof candidate.code !== 'string') return null;
  if (typeof candidate.nextStep !== 'string') return null;
  // Only the Intercom client on an Intercom tool may use this bounded classification.
  // Static instructions replace legacy provider nextStep strings; upstream bodies stay private.
  if (canonicalName.startsWith('intercom_') && candidate.name === 'IntercomFullError') {
    const nextStep = INTERCOM_NEXT_STEPS.get(candidate.code);
    if (!nextStep) return null;
    const status = typeof candidate.status === 'number' && Number.isInteger(candidate.status) &&
      (candidate.status === 0 || (candidate.status >= 100 && candidate.status <= 599))
      ? candidate.status : undefined;
    return { code: candidate.code, nextStep, status };
  }
  const isPinnedObservationError = canonicalName === 'github_graphrag_observation_receipt_get' &&
    candidate.name === 'PinnedObservationReaderError' &&
    candidate.code === 'github_observation_receipt_unverified';
  if (!isPinnedObservationError && (!candidate.name || (candidate.name !== 'CustomerIoApiError' && candidate.name !== 'N8nWebhookError'))) {
    return null;
  }
  return {
    code: candidate.code,
    nextStep: candidate.nextStep,
    status: typeof candidate.status === 'number' ? candidate.status : undefined,
  };
}

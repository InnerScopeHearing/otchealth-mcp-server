export const PINNED_OBSERVATION_FAILURE_STAGES = [
  'installation_token',
  'repository_metadata',
  'workflow_run_metadata',
  'workflow_blob_provenance',
  'producer_blob_provenance',
  'artifact_metadata',
  'artifact_download',
  'artifact_expiry',
  'archive_digest',
  'zip_receipt_extraction',
  'receipt_schema',
  'result_projection',
] as const;

export type PinnedObservationFailureStage = (typeof PINNED_OBSERVATION_FAILURE_STAGES)[number];

export interface PinnedObservationInternalDiagnostic {
  type: 'github_observation_receipt';
  stage: PinnedObservationFailureStage;
  correlation_id: string;
}

const PINNED_OBSERVATION_FAILURE_STAGE_SET: ReadonlySet<string> = new Set(PINNED_OBSERVATION_FAILURE_STAGES);

/** Project only a fixed, non-sensitive stage code to the authenticated CTO caller. */
export function projectPinnedObservationDiagnostic(
  error: unknown,
  canonicalToolName: string,
  callerAgent: string,
  correlationId: string,
): PinnedObservationInternalDiagnostic | null {
  if (canonicalToolName !== 'github_graphrag_observation_receipt_get' || callerAgent !== 'cto' || !error || typeof error !== 'object') return null;
  const candidate = error as Record<string, unknown>;
  if (candidate.name !== 'PinnedObservationReaderError' || candidate.code !== 'github_observation_receipt_unverified') return null;

  const diagnostic = candidate.internalDiagnostic;
  if (!diagnostic || typeof diagnostic !== 'object') return null;
  const internal = diagnostic as Record<string, unknown>;
  if (internal.type !== 'github_observation_receipt' || typeof internal.stage !== 'string' ||
      !PINNED_OBSERVATION_FAILURE_STAGE_SET.has(internal.stage)) return null;

  return {
    type: 'github_observation_receipt',
    stage: internal.stage as PinnedObservationFailureStage,
    correlation_id: correlationId,
  };
}

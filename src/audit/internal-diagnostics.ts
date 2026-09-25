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

export const PINNED_OBSERVATION_RUN_METADATA_FIELDS = [
  'run',
  'id',
  'name',
  'path',
  'event',
  'status',
  'conclusion',
  'head_branch',
  'head_sha',
  'repository',
  'repository.id',
  'repository.full_name',
  'head_repository',
  'head_repository.id',
  'head_repository.full_name',
] as const;

export type PinnedObservationRunMetadataField = (typeof PINNED_OBSERVATION_RUN_METADATA_FIELDS)[number];

export type PinnedObservationFailureDetail =
  | { kind: 'http_status'; status: number }
  | { kind: 'run_metadata_field'; field: PinnedObservationRunMetadataField };

export interface PinnedObservationInternalDiagnostic {
  type: 'github_observation_receipt';
  stage: PinnedObservationFailureStage;
  correlation_id: string;
  detail?: PinnedObservationFailureDetail;
}

const PINNED_OBSERVATION_FAILURE_STAGE_SET: ReadonlySet<string> = new Set(PINNED_OBSERVATION_FAILURE_STAGES);
const PINNED_OBSERVATION_RUN_METADATA_FIELD_SET: ReadonlySet<string> = new Set(PINNED_OBSERVATION_RUN_METADATA_FIELDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectWorkflowRunMetadataDetail(
  stage: PinnedObservationFailureStage,
  value: unknown,
): PinnedObservationFailureDetail | null {
  if (stage !== 'workflow_run_metadata' || !isRecord(value)) return null;
  if (value.kind === 'http_status' && typeof value.status === 'number' && Number.isInteger(value.status) &&
      value.status >= 200 && value.status <= 599) {
    return { kind: 'http_status', status: value.status };
  }
  if (value.kind === 'run_metadata_field' && typeof value.field === 'string' &&
      PINNED_OBSERVATION_RUN_METADATA_FIELD_SET.has(value.field)) {
    return { kind: 'run_metadata_field', field: value.field as PinnedObservationRunMetadataField };
  }
  return null;
}

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

  const stage = internal.stage as PinnedObservationFailureStage;
  const projected: PinnedObservationInternalDiagnostic = {
    type: 'github_observation_receipt',
    stage,
    correlation_id: correlationId,
  };
  if (internal.detail !== undefined) {
    const detail = projectWorkflowRunMetadataDetail(stage, internal.detail);
    if (!detail) return null;
    projected.detail = detail;
  }
  return projected;
}

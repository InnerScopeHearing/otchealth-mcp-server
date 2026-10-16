import { createHash } from 'node:crypto';
import { logger } from './logger.js';
import { currentParentCorrelationId } from '../server/request-context.js';

export const TOOL_TIMING_PHASES = [
  'queue', 'credentials', 'initialize', 'operation', 'shutdown', 'registration', 'projection', 'serialization', 'write',
] as const;
export type ToolTimingPhase = (typeof TOOL_TIMING_PHASES)[number];
export type ToolTimingOutcome = 'success' | 'error' | 'rejected' | 'unknown';

export interface ToolTimingObservation {
  parentCorrelationId?: string;
  toolCorrelationId?: string;
  phase: string;
  durationMs: number;
  outcome: ToolTimingOutcome;
  /** Existing fixed diagnostic code only; arbitrary error messages are never accepted. */
  errorCode?: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** Closed set of existing gateway/AWS diagnostics; unknown provider text is omitted. */
const SAFE_ERROR_CODES = new Set([
  'tool_error', 'invalid_input', 'forbidden_role', 'github_invalid_path', 'github_owner_not_allowed',
  'github_write_phi_rejected', 'github_pre_share_blocked', 'write_disabled', 'cold_start_enforced',
  'prompt_injection_blocked', 'ungrounded_blocked', 'upstream_error', 'rate_limited',
  'aws_mcp_timeout', 'aws_mcp_busy', 'aws_mcp_throttled', 'aws_mcp_rejected', 'aws_mcp_upstream_http',
  'aws_mcp_upstream_error', 'aws_mcp_network', 'aws_mcp_response_too_large', 'aws_mcp_protocol',
  'aws_mcp_forbidden', 'aws_mcp_grant_refused', 'aws_mcp_disabled', 'aws_mcp_invalid_input',
  'aws_mcp_tool_blocked', 'aws_mcp_tool_not_allowed', 'aws_mcp_unavailable',
  'aws_mcp_upstream_tool_error', 'aws_mcp_internal_error',
]);
const PHASE_SET = new Set<string>(TOOL_TIMING_PHASES);
const OUTCOMES = new Set<string>(['success', 'error', 'rejected', 'unknown']);

/** Stable deterministic 10% sample per parent MCP request; retain all bounded non-success outcomes. */
export function shouldSampleToolTiming(parentCorrelationId: string | undefined, outcome: ToolTimingOutcome): boolean {
  if (outcome !== 'success') return true;
  if (!parentCorrelationId || !SAFE_ID.test(parentCorrelationId)) return false;
  const bucket = createHash('sha256').update(parentCorrelationId).digest().readUInt32BE(0) % 100;
  return bucket < 10;
}

/** Build an allowlisted, content-free event. Invalid labels and IDs are omitted. */
export function toolTimingLogFields(observation: ToolTimingObservation): Record<string, unknown> {
  const phase = PHASE_SET.has(observation.phase) ? observation.phase : undefined;
  const outcome = OUTCOMES.has(observation.outcome) ? observation.outcome : 'unknown';
  const duration = Number.isFinite(observation.durationMs) && observation.durationMs >= 0
    ? Math.min(1_000_000_000, Math.round(observation.durationMs)) : 0;
  const fields: Record<string, unknown> = {
    type: 'tool_phase_timing',
    phase,
    duration_ms: duration,
    outcome,
  };
  if (observation.parentCorrelationId && SAFE_ID.test(observation.parentCorrelationId)) {
    fields.mcp_request_correlation_id = observation.parentCorrelationId;
  }
  if (observation.toolCorrelationId && SAFE_ID.test(observation.toolCorrelationId)) {
    fields.correlation_id = observation.toolCorrelationId;
  }
  if (observation.errorCode && SAFE_ERROR_CODES.has(observation.errorCode)) fields.error_code = observation.errorCode;
  return fields;
}

/** Emit one fixed-dimension phase observation, linked to the current parent request when available. */
export function logToolPhase(observation: Omit<ToolTimingObservation, 'parentCorrelationId'>): boolean {
  const parentCorrelationId = currentParentCorrelationId();
  // Keep a fixed-dimension error observation even for legacy/non-MCP call paths; do not invent an ID.
  if (parentCorrelationId && !shouldSampleToolTiming(parentCorrelationId, observation.outcome)) return false;
  if (!parentCorrelationId && observation.outcome === 'success') return false;
  try {
    logger.info(toolTimingLogFields({ ...observation, parentCorrelationId }), 'tool phase timing');
    return true;
  } catch {
    // Observability must never change an upstream call's result.
    return false;
  }
}

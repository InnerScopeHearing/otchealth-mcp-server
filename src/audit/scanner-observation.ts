import { logger } from './logger.js';

export const SCANNER_FAILURE_STAGES = [
  'configuration',
  'input_validation',
  'endpoint_resolution',
  'signature_before_scan',
  'scan',
  'signature_after_scan',
] as const;
export type ScannerFailureStage = (typeof SCANNER_FAILURE_STAGES)[number];

export const SCANNER_FAILURE_REASONS = [
  'invalid_configuration',
  'invalid_input',
  'endpoint_forbidden',
  'endpoint_resolution_failed',
  'timeout',
  'transport_error',
  'signature_invalid',
  'signature_stale',
  'verdict_invalid',
  'signature_changed',
  'protocol_error',
  'unexpected_error',
] as const;
export type ScannerFailureReason = (typeof SCANNER_FAILURE_REASONS)[number];

export interface ScannerFailureObservation {
  stage: ScannerFailureStage;
  reason: ScannerFailureReason;
  durationMs: number;
  signatureAgeMs?: number;
}

const STAGES = new Set<string>(SCANNER_FAILURE_STAGES);
const REASONS = new Set<string>(SCANNER_FAILURE_REASONS);

/** Structured scanner failure fields. This is deliberately a closed content-free schema. */
export function scannerFailureLogFields(observation: ScannerFailureObservation): Record<string, unknown> {
  const duration = Number.isFinite(observation.durationMs) && observation.durationMs >= 0
    ? Math.min(60_000, Math.round(observation.durationMs)) : 0;
  const fields: Record<string, unknown> = {
    type: 'browser_file_scanner_failure',
    stage: STAGES.has(observation.stage) ? observation.stage : 'input_validation',
    reason: REASONS.has(observation.reason) ? observation.reason : 'unexpected_error',
    outcome: 'quarantined',
    duration_ms: duration,
  };
  if (Number.isSafeInteger(observation.signatureAgeMs) && observation.signatureAgeMs! >= 0) {
    fields.signature_age_ms = observation.signatureAgeMs;
  }
  return fields;
}

/** A logging failure must never change scanner fail-closed behavior. */
export function logBrowserFileScannerFailure(observation: ScannerFailureObservation): void {
  try {
    logger.warn(scannerFailureLogFields(observation), 'browser file scanner failed closed');
  } catch {
    // Keep the original scanner error outcome if the logger is unavailable.
  }
}

import { logger } from './logger.js';

export type ResultProjectionOutcome = 'inline' | 'offloaded' | 'fail_open' | 'retrieved';

const ALLOWED_OUTCOMES = new Set<ResultProjectionOutcome>(['inline', 'offloaded', 'fail_open', 'retrieved']);

export interface ResultProjectionMeasurement {
  outcome: ResultProjectionOutcome;
  originalBytes: number;
  initialReturnBytes?: number;
  returnedBytes?: number;
  page?: number;
  pages?: number;
}

const SIZE_CLASSES = [
  { max: 40 * 1024, name: 'under-40KiB' },
  { max: 64 * 1024, name: '40KiB-64KiB' },
  { max: 256 * 1024, name: '64KiB-256KiB' },
  { max: 1024 * 1024, name: '256KiB-1MiB' },
  { max: 1_600_000, name: '1MiB-1.6MiB' },
] as const;

function nonNegativeInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && value! >= 0;
}

/** Content-free structured fields for the bounded result projection event. */
export function resultProjectionLogFields(measurement: ResultProjectionMeasurement): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    type: 'result_projection',
    outcome: ALLOWED_OUTCOMES.has(measurement.outcome) ? measurement.outcome : 'unknown',
  };
  if (nonNegativeInteger(measurement.originalBytes)) {
    fields.size_class = SIZE_CLASSES.find(({ max }) => measurement.originalBytes <= max)?.name ?? 'over-1.6MiB';
    fields.original_bytes = measurement.originalBytes;
  } else {
    fields.size_class = 'unknown';
  }
  if (nonNegativeInteger(measurement.initialReturnBytes)) fields.initial_return_bytes = measurement.initialReturnBytes;
  if (nonNegativeInteger(measurement.returnedBytes)) fields.returned_bytes = measurement.returnedBytes;
  if (nonNegativeInteger(measurement.page)) fields.page = measurement.page;
  if (nonNegativeInteger(measurement.pages)) fields.pages = measurement.pages;
  return fields;
}

export function logResultProjection(measurement: ResultProjectionMeasurement): void {
  try {
    logger.info(resultProjectionLogFields(measurement), 'result_projection');
  } catch {
    // Observability must never change the existing fail-open result contract.
  }
}

/**
 * Azure Document Intelligence (Form Recognizer) API client.
 *
 * Required env vars:
 *   DOCINTEL_ENDPOINT  – e.g. https://di-otchealth.cognitiveservices.azure.com
 *   DOCINTEL_KEY       – Azure subscription key (Ocp-Apim-Subscription-Key)
 *
 * PHI / RING SAFETY WARNING:
 *   This gateway is NOT covered by a Business Associate Agreement (BAA).
 *   NEVER route PHI, MedReview documents, or any clinical records through
 *   these tools. Permitted content: CFO finance documents (invoices, receipts)
 *   and CLO commercial contracts only. PHI goes to the BAA-covered engine.
 */

export interface AnalyzeSource {
  urlSource?: string;
  base64Source?: string;
}

export interface AnalyzeResultOk {
  status: 'succeeded';
  analyzeResult: Record<string, unknown>;
}

export interface AnalyzeResultFailed {
  status: 'failed' | 'timedOut' | 'notConfigured' | 'retired';
  error?: string;
}

export type AnalyzeOutcome = AnalyzeResultOk | AnalyzeResultFailed;

export class DocIntelApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  constructor(args: { code: string; status: number; message: string; nextStep: string }) {
    super(args.message);
    this.name = 'DocIntelApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
  }
}

/**
 * Analyze a document against a Document Intelligence model.
 *
 * Submits the job, polls Operation-Location until succeeded/failed/timeout,
 * and returns the full analyzeResult blob.
 *
 * On missing credentials, returns a flagged inert result (no throw) so the
 * gateway continues to boot with partial config.
 */
export async function analyzeDocument(
  modelId: string,
  source: AnalyzeSource,
): Promise<AnalyzeOutcome> {
  // Azure Document Intelligence is retired with the deleted Azure estate. Keep the
  // adapter source-owned for historical reference, but fail closed before reading
  // configuration or touching the provider. This also prevents a stale secret from
  // accidentally reactivating a billed external call.
  void modelId;
  void source;
  return {
    status: 'retired',
    error: 'Azure Document Intelligence is retired; no provider call was attempted.',
  };

}

/**
 * Pluck a field value from the DI fields map. Returns the content string or
 * undefined if absent. DI field objects carry { content, valueString, valueDate,
 * valueNumber, ... } — we prefer the typed value, falling back to content.
 */
export function fieldValue(fields: Record<string, any> | undefined, key: string): string | undefined {
  const f = fields?.[key];
  if (!f) return undefined;
  // Prefer typed scalar values over raw content
  const typed =
    f.valueString ??
    f.valueDate ??
    f.valueNumber ??
    f.valueCurrency?.amount ??
    f.content;
  return typed !== undefined && typed !== null ? String(typed) : undefined;
}

/**
 * Extract currency code from a currency field (if present).
 */
export function fieldCurrency(fields: Record<string, any> | undefined, key: string): string | undefined {
  return fields?.[key]?.valueCurrency?.currencyCode ?? undefined;
}

/**
 * Return an array from a DI array field, or [] if absent.
 */
export function fieldArray(fields: Record<string, any> | undefined, key: string): any[] {
  return fields?.[key]?.valueArray ?? [];
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { currentCorrelationId } from '../server/request-context.js';

export type ProviderUsageStage = 'planning' | 'retrieval' | 'refinement' | 'synthesis' | 'shadow' | 'unknown';
export type ProviderUsageKind = 'chat' | 'embedding' | 'other';
export type UsageState = 'reported' | 'missing' | 'invalid';

interface StageContext {
  stage: ProviderUsageStage;
  correlationId: string;
  releaseId: string;
}

const stageContext = new AsyncLocalStorage<StageContext>();
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_RELEASE = /^[a-f0-9]{7,64}$/i;
const STAGES = new Set<ProviderUsageStage>(['planning', 'retrieval', 'refinement', 'synthesis', 'shadow', 'unknown']);

export function validatedCorrelationId(value: unknown): string {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : 'unknown';
}

export function validatedReleaseId(value: unknown): string {
  return typeof value === 'string' && SAFE_RELEASE.test(value) ? value : 'unknown';
}

export function currentProviderUsageContext(): Readonly<StageContext> {
  return stageContext.getStore() ?? {
    stage: 'unknown',
    correlationId: validatedCorrelationId(currentCorrelationId()),
    releaseId: validatedReleaseId(process.env.GIT_SHA ?? ''),
  };
}

export function withProviderUsageStage<T>(stage: Exclude<ProviderUsageStage, 'unknown'>, run: () => Promise<T>): Promise<T> {
  return stageContext.run({
    stage,
    correlationId: validatedCorrelationId(currentCorrelationId()),
    releaseId: validatedReleaseId(process.env.GIT_SHA ?? ''),
  }, run);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ProviderUsageReceipt {
  type: 'provider_usage_receipt';
  schema_version: 1;
  provider: 'openai';
  kind: ProviderUsageKind;
  stage: ProviderUsageStage;
  correlation_id: string;
  release_id: string;
  usage_state: UsageState;
  returned_model?: string;
  prompt_tokens?: number;
  total_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  estimated_cost_usd?: number;
  estimate?: true;
  price_table_version?: string;
  unknown_model_price?: boolean;
  estimate_model_source?: 'returned' | 'requested_fallback';
}

/** Build a strict allowlist receipt from the raw successful provider response fields. */
export function buildProviderUsageReceipt(input: {
  kind: unknown;
  usage: unknown;
  returnedModel?: unknown;
  requestedModel?: unknown;
  context?: Readonly<StageContext>;
  estimate?: (input: { model: string; kind: ProviderUsageKind; promptTokens: number; completionTokens: number; cachedTokens: number }) => { costUsd: number; unknown: boolean };
  priceTableVersion?: string;
}): ProviderUsageReceipt {
  const context = input.context ?? currentProviderUsageContext();
  const kind: ProviderUsageKind = input.kind === 'embedding' ? 'embedding' : input.kind === 'chat' ? 'chat' : 'other';
  const safeStage = STAGES.has(context.stage) ? context.stage : 'unknown';
  const receipt: ProviderUsageReceipt = {
    type: 'provider_usage_receipt',
    schema_version: 1,
    provider: 'openai',
    kind,
    stage: safeStage,
    correlation_id: validatedCorrelationId(context.correlationId),
    release_id: validatedReleaseId(context.releaseId),
    usage_state: 'missing',
  };
  const returnedModel = typeof input.returnedModel === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input.returnedModel)
    ? input.returnedModel
    : undefined;
  if (returnedModel) receipt.returned_model = returnedModel;

  if (input.usage === undefined || input.usage === null) return receipt;
  if (!isRecord(input.usage)) {
    receipt.usage_state = 'invalid';
    return receipt;
  }
  const recognizedKeys = kind === 'embedding' ? ['prompt_tokens', 'total_tokens'] : ['prompt_tokens', 'completion_tokens', 'prompt_tokens_details'];
  if (!recognizedKeys.some((key) => Object.hasOwn(input.usage as object, key))) return receipt;
  const rawPrompt = input.usage.prompt_tokens;
  const promptTokens = tokenCount(rawPrompt);
  const rawTotal = kind === 'embedding' ? input.usage.total_tokens : undefined;
  const totalTokens = tokenCount(rawTotal);
  const estimateInputTokens = promptTokens ?? totalTokens;
  const completionTokens = kind === 'embedding' ? 0 : tokenCount(input.usage.completion_tokens);
  const details = input.usage.prompt_tokens_details;
  const rawCached = isRecord(details) ? details.cached_tokens : undefined;
  const cachedTokens = rawCached === undefined ? 0 : tokenCount(rawCached);
  const hasRequiredCounts = (promptTokens !== undefined || kind === 'embedding' && totalTokens !== undefined) && (kind === 'embedding' || completionTokens !== undefined);
  const hasInvalidValue = rawPrompt !== undefined && promptTokens === undefined
    || rawTotal !== undefined && totalTokens === undefined
    || kind !== 'embedding' && input.usage.completion_tokens !== undefined && completionTokens === undefined
    || rawCached !== undefined && cachedTokens === undefined;
  if (!hasRequiredCounts || hasInvalidValue || details !== undefined && !isRecord(details) || (cachedTokens !== undefined && promptTokens !== undefined && cachedTokens > promptTokens)) {
    receipt.usage_state = 'invalid';
    if (promptTokens !== undefined) receipt.prompt_tokens = promptTokens;
    if (totalTokens !== undefined) receipt.total_tokens = totalTokens;
    if (kind !== 'embedding' && completionTokens !== undefined) receipt.completion_tokens = completionTokens;
    if (rawCached !== undefined && cachedTokens !== undefined) receipt.cached_tokens = cachedTokens;
    return receipt;
  }
  receipt.usage_state = 'reported';
  if (promptTokens !== undefined) receipt.prompt_tokens = promptTokens;
  if (totalTokens !== undefined) receipt.total_tokens = totalTokens;
  if (kind !== 'embedding') receipt.completion_tokens = completionTokens!;
  if (rawCached !== undefined) receipt.cached_tokens = cachedTokens!;

  const estimateModel = returnedModel ?? (typeof input.requestedModel === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input.requestedModel) ? input.requestedModel : undefined);
  if (kind !== 'other' && estimateModel && input.estimate) {
    const priced = input.estimate({
      model: estimateModel,
      kind,
      promptTokens: estimateInputTokens!,
      completionTokens: completionTokens ?? 0,
      cachedTokens: cachedTokens ?? 0,
    });
    if (Number.isFinite(priced.costUsd) && priced.costUsd >= 0) {
      receipt.estimated_cost_usd = priced.costUsd;
      receipt.estimate = true;
      if (typeof input.priceTableVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.priceTableVersion)) receipt.price_table_version = input.priceTableVersion;
      receipt.unknown_model_price = priced.unknown;
      receipt.estimate_model_source = returnedModel ? 'returned' : 'requested_fallback';
    }
  }
  return receipt;
}

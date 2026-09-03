/**
 * Datadog LLM Observability span emission for the gateway's Bedrock calls (currently:
 * shield_check / groundedness_check via ../safety/bedrock-guardrails.ts's ApplyGuardrail calls).
 * Mirrors this directory's existing datadog-metrics.ts conventions (fire-and-forget, fail-open,
 * INERT unless explicitly enabled) but targets the separate LLM Observability Spans intake
 * endpoint instead of the general v2/series metrics API.
 *
 * RESEARCH (T-5, 2026-09-03 -- verified against the live docs, not guessed; see the PR description
 * for the full research writeup and every URL fetched):
 *
 *   https://docs.datadoghq.com/llm_observability/setup/api/  (the path this file implements)
 *     - Endpoint: POST https://api.<DD_SITE>/api/intake/llm-obs/v1/trace/spans
 *     - Header: DD-API-KEY only (no application key, no other auth).
 *     - The page states this product is "not supported for" app.ddog-gov.com and us2.ddog-gov.com
 *       ONLY. Every other listed site -- INCLUDING us3.datadoghq.com, this fleet's site (see
 *       DD_SITE in the gateway env / config/env.ts) -- is supported by omission from that
 *       unsupported list. No dd-trace SDK and no Datadog Agent are required for this path: it is
 *       a plain JSON POST, the exact same request shape this directory's sibling
 *       datadog-metrics.ts already uses (successfully, in production) for the v2/series metrics
 *       API on this same site.
 *     - Payload shape: {data:{type:'span', attributes:{ml_app, tags?, session_id?, spans:[...]}}}.
 *       Each span object: {span_id, trace_id, parent_id, name, start_ns, duration, status?, meta?,
 *       metrics?}. `start_ns`/`duration` are NANOSECONDS (confirmed from the docs' own worked
 *       example: `"duration": 2000000000` annotated as a 2-second span). `meta.kind` is one of
 *       agent|workflow|llm|tool|task|embedding|retrieval. `meta` also carries input/output/
 *       metadata/model_name/model_provider/model_version/error; `metrics` carries input_tokens/
 *       output_tokens/total_tokens (plus cache/cost/latency variants this file does not use).
 *       `ml_app` is required (lowercase, <=193 chars); `tags` is a top-level attributes field;
 *       `status` defaults to "ok" (values: "ok"|"error"); `error` is {message, stack, type}.
 *
 *   https://docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/ and
 *   https://docs.datadoghq.com/opentelemetry/setup/agentless/  (the path this file does NOT use)
 *     - A separate, newer ingestion path exists under a product Datadog calls "Agent
 *       Observability", built on OTel 1.37+ GenAI semantic conventions (gen_ai.provider.name,
 *       gen_ai.operation.name, gen_ai.request.model, gen_ai.usage.input_tokens/output_tokens,
 *       gen_ai.input.messages/gen_ai.output.messages, ...). It is reachable three ways: through
 *       the Datadog Agent in OTLP mode, through an OTel Collector, or -- per the agentless-setup
 *       doc -- a direct-to-Datadog OTLP intake (paths /v1/traces, /v1/logs, /v1/metrics) that the
 *       docs explicitly and repeatedly label "in Preview" and recommend AGAINST for production use
 *       in favor of an Agent/Collector (for metadata enrichment and signal normalization Datadog
 *       says the direct path skips). The one concrete non-generic detail the docs did surface for
 *       the LLM-flavored OTel path is a header combination -- "dd-api-key=<KEY>,
 *       dd-otlp-source=llmobs" -- but the actual OTLP intake HOSTNAME was not stated in what the
 *       fetched pages returned, and going this route would additionally require either an OTLP/
 *       protobuf encoder or an OTel JS SDK dependency this repo does not currently carry, for a
 *       Preview-labeled, agent-recommended path. NOT used here: the plain-JSON LLM Observability
 *       Spans API above is simpler, explicitly non-Preview, already proven supported on this
 *       site's non-OTel product, and matches this file's own zero-new-dependency fetch-based
 *       emitter convention exactly. Revisit if Datadog GAs the direct OTLP path and documents its
 *       intake host, or if the fleet later wants OTel-native cross-vendor portability.
 *
 * SAFETY CONTRACT (mirrors datadog-metrics.ts's, and this repo's bedrock-guardrails.ts's own
 * "never surface the sensitive field even in an already-scoped internal payload" precedent):
 *   - INERT BY DEFAULT: emitLlmObsSpan() reads nothing but the DD_LLMOBS_ENABLED flag itself, and
 *     returns immediately (no crypto, no further env reads, no fetch) unless that flag is truthy.
 *     A deploy with this file present and DD_LLMOBS_ENABLED unset is a byte-for-byte no-op --
 *     never a regression, and safe to land ahead of actually flipping the flag anywhere.
 *   - NEVER sends prompt/completion/document TEXT unless DD_LLMOBS_CAPTURE_CONTENT is ALSO truthy
 *     (default off, independent flag). Even then this module only forwards whatever
 *     `inputText`/`outputText` a caller explicitly supplies in LlmObsSpanInput -- it never reaches
 *     back into a request/response object on its own. As of this file's introduction, this
 *     repo's ONLY call site (bedrock-guardrails.ts) deliberately never populates those two fields
 *     AT ALL, regardless of the flag: a shield/groundedness scan's own input can be an arbitrary
 *     caller-supplied prompt or grounding document, exactly the class of content this fleet
 *     already treats as too sensitive to forward to a third-party vendor even when a field is
 *     redaction-shaped (see bedrock-guardrails.ts's own module doc comment, "DELIBERATELY NOT
 *     SURFACED IN THE STRUCTURED RESULT", for the established precedent this follows). Only
 *     categorical/boolean/numeric signals (attackDetected, piiEntityTypes -- TYPES only, never a
 *     matched value -- ungroundedPercentage, token counts, latency) are ever sent from that site.
 *   - Fire-and-forget: emitLlmObsSpan() is never awaited by a caller, never throws, times out fast
 *     (1.5s), and swallows every failure (network, non-2xx, malformed payload). A bug or outage in
 *     this file must never affect the guardrail (or future LLM) call it instruments.
 */

import { randomBytes } from 'node:crypto';

export type LlmObsSpanKind = 'llm' | 'tool' | 'task' | 'workflow' | 'agent' | 'embedding' | 'retrieval';

export interface LlmObsSpanInput {
  /** Short, stable operation name, e.g. "bedrock.apply_guardrail.shield" or "bedrock.converse". */
  name: string;
  kind: LlmObsSpanKind;
  /** Nanoseconds since epoch. Use nowNs() at the call's start. */
  startNs: number;
  /** Span duration in nanoseconds (NOT milliseconds -- see this file's doc comment). */
  durationNs: number;
  /** False renders status:"error" and attaches meta.error; true renders status:"ok". */
  ok: boolean;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Small, non-content, categorical/boolean/numeric signals only (e.g. guardrail
   *  action/outcome, stop_reason). Never put prompt/completion/document text here -- use
   *  inputText/outputText instead, which are gated separately (see this file's doc comment). */
  metadata?: Record<string, unknown>;
  /** Only meaningful when ok is false. Truncated defensively before send. */
  errorMessage?: string;
  /** Raw content. NEVER sent unless DD_LLMOBS_CAPTURE_CONTENT is truthy -- see this file's doc
   *  comment for why this repo's real call sites never populate these fields at all. */
  inputText?: string;
  outputText?: string;
  tags?: string[];
}

const MAX_ERROR_LEN = 500;
const MAX_CONTENT_LEN = 4000;

/** Nanoseconds since epoch, from Date.now() (millisecond resolution; the *1e6 conversion is an
 *  approximation, not a true nanosecond clock -- Datadog's own field is documented in ns, and
 *  this is the same precision the gateway's other timing already works at). Exported so a call
 *  site can capture a start timestamp without duplicating the conversion. */
export function nowNs(): number {
  return Date.now() * 1e6;
}

function envFlag(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

function isLlmObsEnabled(): boolean {
  return envFlag('DD_LLMOBS_ENABLED');
}

function captureContentEnabled(): boolean {
  return envFlag('DD_LLMOBS_CAPTURE_CONTENT');
}

function mlApp(): string {
  return (process.env.DD_LLMOBS_ML_APP || '').trim() || 'otchealth-gateway';
}

/** Same credential/site resolution as datadog-metrics.ts's private resolveDdCreds() --
 *  duplicated rather than imported so this file has zero coupling to that module's internals
 *  (both stay independently reviewable/testable, and neither can break the other). Prefers a
 *  DEDICATED metrics key so this can be enabled without turning on full APM tracing
 *  (instrument.ts keys APM off DD_API_KEY alone); falls back to DD_API_KEY when one key covers
 *  both. Never throws. */
function resolveDdCreds(): { key: string; site: string } {
  try {
    return {
      key: process.env.DD_METRICS_API_KEY || process.env.DD_API_KEY || '',
      site: process.env.DD_SITE || 'datadoghq.com',
    };
  } catch {
    return { key: '', site: 'datadoghq.com' };
  }
}

/** 16 lowercase hex characters (64 bits) -- a standalone reporting span/trace id. This module
 *  reports isolated spans (not correlated with dd-trace's own APM trace ids), so any sufficiently
 *  random fixed-width hex id satisfies the API's {span_id, trace_id} string contract. */
export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

export interface LlmObsSpanIds {
  spanId: string;
  traceId: string;
}

/**
 * Pure: build one wire-format span object from a caller's LlmObsSpanInput + externally-supplied
 * ids (so tests can assert on deterministic output without depending on crypto randomness).
 * Never throws on malformed numeric fields (non-finite values are simply omitted from `metrics`).
 */
export function buildLlmObsSpan(input: LlmObsSpanInput, ids: LlmObsSpanIds): Record<string, unknown> {
  const meta: Record<string, unknown> = { kind: input.kind };
  if (input.model) meta.model_name = input.model;
  if (input.provider) meta.model_provider = input.provider;
  if (input.metadata && Object.keys(input.metadata).length > 0) meta.metadata = input.metadata;
  if (!input.ok) {
    meta.error = { message: (input.errorMessage || 'unknown error').slice(0, MAX_ERROR_LEN) };
  }
  if (captureContentEnabled()) {
    if (typeof input.inputText === 'string' && input.inputText.length > 0) {
      meta.input = { value: input.inputText.slice(0, MAX_CONTENT_LEN) };
    }
    if (typeof input.outputText === 'string' && input.outputText.length > 0) {
      meta.output = { value: input.outputText.slice(0, MAX_CONTENT_LEN) };
    }
  }

  const metrics: Record<string, number> = {};
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (finite(input.inputTokens)) metrics.input_tokens = input.inputTokens;
  if (finite(input.outputTokens)) metrics.output_tokens = input.outputTokens;
  if (finite(input.totalTokens)) {
    metrics.total_tokens = input.totalTokens;
  } else if (metrics.input_tokens !== undefined || metrics.output_tokens !== undefined) {
    metrics.total_tokens = (metrics.input_tokens || 0) + (metrics.output_tokens || 0);
  }

  const span: Record<string, unknown> = {
    span_id: ids.spanId,
    trace_id: ids.traceId,
    // A literal string, matching Datadog's own worked example for a span with no parent --
    // this module only ever emits standalone root spans, never a correlated trace tree.
    parent_id: 'undefined',
    name: input.name,
    start_ns: Math.round(input.startNs),
    duration: Math.max(0, Math.round(input.durationNs)),
    status: input.ok ? 'ok' : 'error',
    meta,
  };
  if (Object.keys(metrics).length > 0) span.metrics = metrics;
  return span;
}

/**
 * Pure: wrap one or more built spans in the LLM Observability Spans API's top-level envelope.
 * Returns null when there is nothing to send (mirrors datadog-metrics.ts's buildSeriesPayload
 * null-when-empty convention).
 */
export function buildLlmObsPayload(
  spans: Record<string, unknown>[],
  appName: string = mlApp(),
  tags?: string[],
): { data: { type: 'span'; attributes: Record<string, unknown> } } | null {
  if (!spans.length) return null;
  const attributes: Record<string, unknown> = { ml_app: appName, spans };
  if (tags && tags.length > 0) attributes.tags = tags;
  return { data: { type: 'span', attributes } };
}

/** Fire-and-forget POST to the LLM Observability Spans intake. Never awaited, never throws,
 *  1.5s timeout, no-ops when no Datadog key resolves or the payload is empty -- the same shape
 *  as datadog-metrics.ts's submitSeriesFireAndForget, targeting the different intake path this
 *  file's doc comment documents. */
function submitSpanFireAndForget(payload: ReturnType<typeof buildLlmObsPayload>): void {
  if (!payload) return;
  const { key, site } = resolveDdCreds();
  if (!key) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  void fetch(`https://api.${site}/api/intake/llm-obs/v1/trace/spans`, {
    method: 'POST',
    headers: { 'DD-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

/**
 * Emit one LLM Observability span for a single Bedrock (or future LLM-shaped) call. This is the
 * ONLY function real call sites should use. Checks DD_LLMOBS_ENABLED FIRST, before generating
 * any id or touching the network -- see this file's SAFETY CONTRACT doc comment. Never throws.
 */
export function emitLlmObsSpan(input: LlmObsSpanInput): void {
  try {
    if (!isLlmObsEnabled()) return;
    const ids: LlmObsSpanIds = { spanId: generateSpanId(), traceId: generateSpanId() };
    const span = buildLlmObsSpan(input, ids);
    submitSpanFireAndForget(buildLlmObsPayload([span], mlApp(), input.tags));
  } catch {
    // Never let a bug in telemetry break the real call site it is bolted onto.
  }
}

/**
 * Amazon Bedrock Guardrails provider for shield_check / groundedness_check (2026-08-29).
 *
 * Restores a REAL provider behind the two safety tools that PR #260 / FND-20260821-e303 left
 * honestly NOT-RUN once Azure AI Content Safety was permanently retired -- see
 * ./content-safety.ts's module doc comment for that history. content-safety.ts, its
 * CONTENT_SAFETY_RETIRED kill-switch, and its own configured:false / "none (azure retired)"
 * fallback are all UNCHANGED and UNTOUCHED by this file: this module is purely ADDITIVE. The
 * two tool handlers (src/tools/safety/shield-check.ts, groundedness-check.ts) decide, per call,
 * whether Bedrock is configured; when it is not, they fall through to content-safety.ts's
 * existing shieldPrompt()/detectGroundedness() -- byte-for-byte the same NOT-RUN behavior that
 * shipped in #260, unchanged.
 *
 * API CONTRACT -- verified against the LIVE AWS API Reference on 2026-08-29 (not guessed):
 *   https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ApplyGuardrail.html
 *   https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailContentBlock.html
 *   https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailTextBlock.html
 *   https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailContentFilter.html
 *   https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailContextualGroundingFilter.html
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-contextual-grounding-check.html
 * and cross-checked field-for-field against the published @aws-sdk/client-bedrock-runtime@3.1121.0
 * schema (dist-es/schemas/schemas_0.js -- ApplyGuardrailRequest$/ApplyGuardrailResponse$/
 * GuardrailContentFilter$/GuardrailContextualGroundingFilter$/GuardrailTextBlock$). No aws-sdk
 * package is added to this repo's dependencies -- that download was research-only, in a scratch
 * dir outside this worktree, never installed here.
 *
 *   Request:  POST /guardrail/{guardrailIdentifier}/version/{guardrailVersion}/apply
 *             { source: 'INPUT'|'OUTPUT', outputScope?: 'INTERVENTIONS'|'FULL',
 *               content: GuardrailContentBlock[] }
 *   GuardrailContentBlock (union, exactly one member set):
 *             { text?: { text: string, qualifiers?: ('grounding_source'|'query'|'guard_content')[] },
 *               image?: {...} }  -- this file only ever sends `text` blocks.
 *   Response: { action: 'NONE'|'GUARDRAIL_INTERVENED', actionReason?, assessments: [...],
 *               guardrailCoverage?, outputs?, usage? }
 *   assessments[].contentPolicy.filters[]             { type, action, confidence, detected?, filterStrength? }
 *     type includes 'PROMPT_ATTACK' -- the direct analog of Azure's Prompt Shields.
 *   assessments[].contextualGroundingPolicy.filters[] { type: 'GROUNDING'|'RELEVANCE', threshold, score, action, detected? }
 *
 * outputScope is always sent as 'FULL' here. By default (outputScope unset / 'INTERVENTIONS'),
 * ApplyGuardrail returns ONLY entries for content that was actually flagged -- so the ABSENCE of a
 * PROMPT_ATTACK entry would be ambiguous between "checked, found nothing" and "this guardrail
 * doesn't even have the Prompt Attack filter enabled, so it was never checked at all". 'FULL' makes
 * `detected` present (true or false) for every filter type the guardrail actually evaluates, so
 * this file can read `detected` directly instead of inferring cleanliness from absence. See the
 * "Return full output in ApplyGuardrail response" section of the independent-API user guide.
 *
 * shield_check -> source:'INPUT', one text block per userPrompt + each optional document, reading
 * contentPolicy filters of type PROMPT_ATTACK.
 *
 * groundedness_check -> source:'OUTPUT' (per the user guide: "the model response is required to
 * perform the contextual grounding checks and so the checks will only be performed on output and
 * not on the prompt"), with qualifier-tagged blocks -- one 'grounding_source' block per caller-
 * supplied source (AWS combines multiple grounding_source blocks into one reference internally, per
 * the contextual-grounding-check guide's note), one 'query' block, and one 'guard_content' block
 * for the text under evaluation -- reading contextualGroundingPolicy filters of type GROUNDING.
 * RELEVANCE filters (also returned when the guardrail has relevance checking enabled) are left in
 * `raw` for a caller to inspect but are not folded into ungroundedDetected/ungroundedPercentage,
 * which are specifically about groundedness (hallucination), the field this tool has always
 * measured, not query-relevance (a distinct paradigm the underlying Azure API never covered either).
 *
 * ATTRIBUTION LIMIT (documented, not fabricated): unlike Azure's Prompt Shields, which returned
 * SEPARATE userPromptAnalysis / documentsAnalysis[] verdicts, Bedrock's ApplyGuardrail response
 * does not attribute a PROMPT_ATTACK finding back to which content block triggered it. Rather than
 * invent a false split, userPromptAttack and documentsAttack both mirror the same aggregate
 * `attackDetected` signal when documents are present (documentsAttack is still forced false when no
 * documents were sent, preserving the one attribution Azure's shape DID guarantee: "no documents in,
 * no documents attack out").
 *
 * SIGV4: reuses ../search/sigv4.ts's signRequest() with service:'bedrock' (the IAM action namespace
 * for this API is bedrock:ApplyGuardrail -- see the PR's deploy checklist) rather than adding an
 * aws-sdk dependency, the same "no vendor SDK" convention already established for OpenSearch in this
 * repo. DOUBLE-VS-SINGLE ENCODING: AWS's SigV4 spec requires the canonical (signing) request to use
 * a DOUBLE percent-encoded path for every service except S3, while the WIRE path is single-encoded.
 * sigv4.ts's signRequest() applies exactly ONE percent-encoding pass (canonicalUri()) on top of
 * whatever path string the caller already built, for every service including 'es' -- so the
 * existing OpenSearch caller (src/search/opensearch.ts's getDocumentByKey) already achieves the
 * correct double-encode for a raw key with special characters purely by composition: it builds the
 * wire path with one encodeURIComponent() pass, and signRequest()'s internal canonicalUri() adds a
 * second pass on top for the signature only (see sigv4.test.ts's "encoded AGAIN" test, which pins
 * this exact mechanism). buildGuardrailPath() below follows the identical pattern -- one
 * encodeURIComponent() per dynamic path segment -- so the same composition yields a correctly
 * double-encoded canonical request for Bedrock too. In practice a guardrail id/version is
 * constrained by AWS's own URI pattern to plain alphanumerics, 'DRAFT', or an ARN
 * (arn:aws...:guardrail/xxx); a short id round-trips through single vs. double encoding
 * byte-identically (nothing to escape), so this only matters if an ARN (which DOES contain ':' and
 * '/') is ever passed as BEDROCK_GUARDRAIL_ID -- encodeURIComponent() here keeps that case correct
 * too, both on the wire (the ARN's '/' becomes one opaque %2F path segment, not an extra path
 * level) and in the signature (the composed double-encode).
 *
 * CONFIG -- read FRESH from process.env per call (same reasoning as SHIELD_MODE/GROUNDEDNESS_MODE
 * in src/config/env.ts: an operator can flip these without a redeploy):
 *   GUARDRAIL_PROVIDER         must be exactly 'bedrock' (case-insensitive) to select this provider.
 *   BEDROCK_GUARDRAIL_ID       the guardrail's short id or ARN. Required to select 'bedrock'.
 *   BEDROCK_GUARDRAIL_VERSION  defaults to 'DRAFT' when unset/blank.
 *   BEDROCK_REGION             defaults to 'us-east-1' when unset/blank.
 * When GUARDRAIL_PROVIDER isn't 'bedrock', or BEDROCK_GUARDRAIL_ID is unset/blank,
 * isBedrockGuardrailConfigured() is false and the caller falls through to content-safety.ts's
 * existing NOT-RUN path -- EXACTLY today's behavior, unchanged.
 *
 * CREDENTIALS: resolveAwsCredentials() from sigv4.ts (explicit AWS_ACCESS_KEY_ID/SECRET first, then
 * the ECS task-role container-credentials endpoint). Unlike isBedrockGuardrailConfigured() above, a
 * MISSING credential when the operator has already opted into GUARDRAIL_PROVIDER=bedrock is NOT
 * treated as "unconfigured" -- it is a live operational failure, handled by the fail-loud contract
 * below. Silently downgrading an explicit opt-in to a quiet NOT-RUN would reintroduce exactly the
 * failure class this file exists to close (see content-safety.ts's retirement notice for the
 * original "a 401 degraded to the same outcome as unconfigured, so the outage went unnoticed for
 * weeks" incident).
 *
 * FAIL-LOUD CONTRACT: any error calling Bedrock (missing credentials, network failure, a non-2xx
 * response, or a response body that fails to parse) is surfaced as
 * {configured:true, ran:false, error:<detail>} with the corresponding boolean
 * (attackDetected / ungroundedDetected) forced false -- NEVER rendered as a clean verdict. See
 * shield-check.ts's / groundedness-check.ts's summarize functions for how this renders.
 *
 * PII (added 2026-09-02, after live production verification showed sensitiveInformationPolicy
 * coming back null for a prompt containing an SSN and a card number -- the live guardrail
 * m7goqvo48q4m had ZERO PII entities configured; see scripts/create-guardrail.mjs for the
 * idempotent update+version script that adds them). shield_check's source:'INPUT' call ALREADY
 * scans for sensitiveInformationPolicy whenever the guardrail has piiEntitiesConfig entries --
 * ApplyGuardrail evaluates every configured policy on a single call, there is no separate PII
 * request. This just reads assessments[].sensitiveInformationPolicy.piiEntities[] out of the SAME
 * response bedrockShieldPrompt already fetches for PROMPT_ATTACK, exactly like extractGroundingFilters
 * reads a different policy out of a DIFFERENT call's response.
 *
 * DELIBERATELY NOT SURFACED IN THE STRUCTURED RESULT: GuardrailPiiEntityFilter's `match` field (the
 * ACTUAL matched PII text -- e.g. the real SSN or card number). piiEntityTypes below carries only
 * the entity TYPE (e.g. "US_SOCIAL_SECURITY_NUMBER"), never the value. The full `raw` response
 * (which DOES include `match`) is attached exactly as it already was for PROMPT_ATTACK/GROUNDING --
 * this is not a new exposure, `raw` was never redacted for those either -- but registry.ts's
 * logToolEnd only logs payload.audit.before/after (see audit/logger.ts), and shield_check never sets
 * `audit`, so the raw match value is returned to the calling agent but is not additionally written to
 * the gateway's own structured logs by this path.
 */

import { resolveAwsCredentials, signRequest } from '../search/sigv4.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

/** The honest provider label on a result that genuinely called Bedrock (success or failure). */
export const BEDROCK_GUARDRAILS_PROVIDER = 'bedrock';

/** Defensive-only label: bedrockShieldPrompt()/bedrockDetectGroundedness() were called directly
 *  without checking isBedrockGuardrailConfigured() first. The real tool handlers never hit this --
 *  they check isBedrockGuardrailConfigured() and call content-safety.ts's legacy path instead. */
export const BEDROCK_GUARDRAILS_NOT_SELECTED = 'bedrock (not selected)';

function guardrailProviderSelected(): boolean {
  return (process.env.GUARDRAIL_PROVIDER || '').trim().toLowerCase() === BEDROCK_GUARDRAILS_PROVIDER;
}

function guardrailId(): string {
  return (process.env.BEDROCK_GUARDRAIL_ID || '').trim();
}

function guardrailVersion(): string {
  return (process.env.BEDROCK_GUARDRAIL_VERSION || '').trim() || 'DRAFT';
}

function bedrockRegion(): string {
  return (process.env.BEDROCK_REGION || '').trim() || 'us-east-1';
}

/** True only when the operator has explicitly opted into Bedrock (GUARDRAIL_PROVIDER=bedrock) AND
 *  supplied a guardrail id. This is the ONLY gate the two tool handlers check before routing to
 *  this module; everything below assumes it was already true. */
export function isBedrockGuardrailConfigured(): boolean {
  return guardrailProviderSelected() && guardrailId().length > 0;
}

export class BedrockGuardrailError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BedrockGuardrailError';
    this.status = status;
  }
}

export type GuardrailQualifier = 'grounding_source' | 'query' | 'guard_content';

export interface GuardrailContentBlock {
  text: { text: string; qualifiers?: GuardrailQualifier[] };
}

/** Build the ApplyGuardrail wire path with ONE encodeURIComponent() pass per dynamic segment --
 *  see this module's doc comment's SIGV4 section for why that composes into the correct
 *  double-encoded canonical (signing) request via sigv4.ts's signRequest(). Exported for a direct
 *  unit test of the encoding behavior, independent of any network call. */
export function buildGuardrailPath(id: string, version: string): string {
  return `/guardrail/${encodeURIComponent(id)}/version/${encodeURIComponent(version)}/apply`;
}

interface RawContentFilter {
  type?: string;
  action?: string;
  confidence?: string;
  detected?: boolean;
  filterStrength?: string;
}

interface RawGroundingFilter {
  type?: string;
  threshold?: number;
  score?: number;
  action?: string;
  detected?: boolean;
}

/** https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailPiiEntityFilter.html
 *  -- `match` (the actual matched PII text) is intentionally typed here so extractPiiEntities can
 *  read it, but bedrockShieldPrompt below deliberately never copies it into piiEntityTypes; see this
 *  module's PII doc-comment section for why. */
interface RawPiiEntityFilter {
  type?: string;
  action?: string;
  match?: string;
  detected?: boolean;
}

/** Flatten `assessments[].contentPolicy.filters[]` across every assessment entry (there is
 *  typically exactly one, but nothing in the contract guarantees that). Exported for direct
 *  response-mapping unit tests without a network call. Defensive against any missing/malformed
 *  shape -- always returns an array, never throws. */
export function extractContentFilters(raw: unknown): RawContentFilter[] {
  const assessments = Array.isArray((raw as { assessments?: unknown })?.assessments)
    ? ((raw as { assessments: unknown[] }).assessments as Array<Record<string, unknown>>)
    : [];
  return assessments.flatMap((a) => {
    const filters = (a?.contentPolicy as { filters?: unknown } | undefined)?.filters;
    return Array.isArray(filters) ? (filters as RawContentFilter[]) : [];
  });
}

/** Flatten `assessments[].contextualGroundingPolicy.filters[]` across every assessment entry.
 *  Exported for direct response-mapping unit tests without a network call. */
export function extractGroundingFilters(raw: unknown): RawGroundingFilter[] {
  const assessments = Array.isArray((raw as { assessments?: unknown })?.assessments)
    ? ((raw as { assessments: unknown[] }).assessments as Array<Record<string, unknown>>)
    : [];
  return assessments.flatMap((a) => {
    const filters = (a?.contextualGroundingPolicy as { filters?: unknown } | undefined)?.filters;
    return Array.isArray(filters) ? (filters as RawGroundingFilter[]) : [];
  });
}

/** Flatten `assessments[].sensitiveInformationPolicy.piiEntities[]` across every assessment entry.
 *  Exported for direct response-mapping unit tests without a network call. Only populated once the
 *  guardrail has piiEntitiesConfig entries -- see this module's PII doc-comment section. */
export function extractPiiEntities(raw: unknown): RawPiiEntityFilter[] {
  const assessments = Array.isArray((raw as { assessments?: unknown })?.assessments)
    ? ((raw as { assessments: unknown[] }).assessments as Array<Record<string, unknown>>)
    : [];
  return assessments.flatMap((a) => {
    const entities = (a?.sensitiveInformationPolicy as { piiEntities?: unknown } | undefined)?.piiEntities;
    return Array.isArray(entities) ? (entities as RawPiiEntityFilter[]) : [];
  });
}

/**
 * One signed ApplyGuardrail call. Throws BedrockGuardrailError on ANY failure (missing
 * credentials, network error, non-2xx response, unparseable body) -- never returns a "clean"-
 * looking value on failure. Callers (bedrockShieldPrompt / bedrockDetectGroundedness) catch this
 * and map it to the fail-loud {ran:false, error} contract.
 */
export async function applyGuardrail(
  source: 'INPUT' | 'OUTPUT',
  content: GuardrailContentBlock[],
): Promise<unknown> {
  const region = bedrockRegion();
  const id = guardrailId();
  const version = guardrailVersion();
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const path = buildGuardrailPath(id, version);
  const bodyStr = JSON.stringify({ source, outputScope: 'FULL', content });

  const credentials = await resolveAwsCredentials();
  if (!credentials) {
    throw new BedrockGuardrailError(
      'AWS credentials unavailable (checked AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY and the ECS task role)',
    );
  }

  const signed = signRequest({
    method: 'POST',
    host,
    path,
    body: bodyStr,
    region,
    service: 'bedrock',
    credentials,
  });

  let res: Response;
  try {
    res = await fetchWithBudget(
      `https://${host}${path}`,
      { method: 'POST', headers: signed.headers, body: bodyStr },
      { retries: 1 },
    );
  } catch (err) {
    throw new BedrockGuardrailError(
      `network error calling Bedrock ApplyGuardrail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new BedrockGuardrailError(
      `Bedrock ApplyGuardrail returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`,
      res.status,
    );
  }
  if (!res.ok) {
    const body = json as { message?: unknown; Message?: unknown; __type?: unknown } | null;
    const errType = res.headers.get('x-amzn-errortype') || res.headers.get('x-amzn-error-type') || body?.__type;
    const msg =
      (typeof body?.message === 'string' && body.message) ||
      (typeof body?.Message === 'string' && body.Message) ||
      `HTTP ${res.status}`;
    throw new BedrockGuardrailError(
      `Bedrock ApplyGuardrail failed${errType ? ` (${String(errType)})` : ''}: ${msg}`,
      res.status,
    );
  }
  return json;
}

export interface BedrockShieldResult {
  configured: boolean;
  ran: boolean;
  attackDetected: boolean;
  userPromptAttack: boolean;
  documentsAttack: boolean;
  /** True when the SAME source:'INPUT' call also found sensitive PII (independent of
   *  attackDetected -- a prompt can contain PII without being a prompt-injection attack, and vice
   *  versa). Always false while the guardrail has no piiEntitiesConfig entries -- see this module's
   *  PII doc-comment section. */
  piiDetected: boolean;
  /** Deduplicated PII entity TYPES only (e.g. "EMAIL", "US_SOCIAL_SECURITY_NUMBER") for entities
   *  with detected:true. NEVER the matched value itself -- see this module's PII doc-comment
   *  section for why. Empty array when piiDetected is false. */
  piiEntityTypes: string[];
  provider: string;
  error?: string;
  raw: unknown;
}

/**
 * source:'INPUT' ApplyGuardrail call scanning `userPrompt` and each optional `document` for the
 * PROMPT_ATTACK content-policy filter. See this module's doc comment for the ATTRIBUTION LIMIT
 * (userPromptAttack/documentsAttack cannot be split by Bedrock's response shape the way Azure's
 * could -- both mirror the aggregate `attackDetected` signal, with documentsAttack forced false
 * when no documents were provided).
 */
export async function bedrockShieldPrompt(
  userPrompt: string,
  documents?: string[],
): Promise<BedrockShieldResult> {
  if (!isBedrockGuardrailConfigured()) {
    return {
      configured: false,
      ran: false,
      attackDetected: false,
      userPromptAttack: false,
      documentsAttack: false,
      piiDetected: false,
      piiEntityTypes: [],
      provider: BEDROCK_GUARDRAILS_NOT_SELECTED,
      raw: { skipped: 'Bedrock Guardrails not selected (set GUARDRAIL_PROVIDER=bedrock and BEDROCK_GUARDRAIL_ID)' },
    };
  }
  const hasDocuments = Array.isArray(documents) && documents.length > 0;
  const content: GuardrailContentBlock[] = [
    { text: { text: userPrompt } },
    ...(documents || []).map((d) => ({ text: { text: d } }) as GuardrailContentBlock),
  ];
  try {
    const raw = await applyGuardrail('INPUT', content);
    const attackDetected = extractContentFilters(raw).some(
      (f) => f.type === 'PROMPT_ATTACK' && f.detected === true,
    );
    // PII: type-only, deduplicated, never the matched value -- see this module's PII doc-comment
    // section (RawPiiEntityFilter's own doc comment repeats the "never copy `match`" rule at the
    // point it would be easiest to accidentally do so).
    const detectedPiiTypes = extractPiiEntities(raw)
      .filter((p) => p.detected === true && typeof p.type === 'string')
      .map((p) => p.type as string);
    const piiEntityTypes = Array.from(new Set(detectedPiiTypes));
    return {
      configured: true,
      ran: true,
      attackDetected,
      userPromptAttack: attackDetected,
      documentsAttack: attackDetected && hasDocuments,
      piiDetected: piiEntityTypes.length > 0,
      piiEntityTypes,
      provider: BEDROCK_GUARDRAILS_PROVIDER,
      raw,
    };
  } catch (err) {
    return {
      configured: true,
      ran: false,
      attackDetected: false,
      userPromptAttack: false,
      documentsAttack: false,
      piiDetected: false,
      piiEntityTypes: [],
      provider: BEDROCK_GUARDRAILS_PROVIDER,
      error: err instanceof Error ? err.message : String(err),
      raw: undefined,
    };
  }
}

export interface BedrockGroundednessResult {
  configured: boolean;
  ran: boolean;
  ungroundedDetected: boolean;
  ungroundedPercentage: number;
  provider: string;
  error?: string;
  raw: unknown;
}

/**
 * source:'OUTPUT' ApplyGuardrail call using qualifier-tagged content blocks (grounding_source /
 * query / guard_content) to run Bedrock's Contextual Grounding check, reading the GROUNDING filter
 * (RELEVANCE, if present, is left in `raw` -- see this module's doc comment for why it is not
 * folded into ungroundedDetected). `ungroundedPercentage` is derived as `1 - score` (a fraction,
 * matching this repo's existing 0..1 convention for that field): Bedrock's `score` is a confidence
 * that the content IS grounded (higher = more grounded; content is flagged when score < threshold),
 * the inverse polarity of "ungrounded percentage", so the fields cannot be used interchangeably.
 */
export async function bedrockDetectGroundedness(
  query: string,
  text: string,
  groundingSources: string[],
): Promise<BedrockGroundednessResult> {
  if (!isBedrockGuardrailConfigured()) {
    return {
      configured: false,
      ran: false,
      ungroundedDetected: false,
      ungroundedPercentage: 0,
      provider: BEDROCK_GUARDRAILS_NOT_SELECTED,
      raw: { skipped: 'Bedrock Guardrails not selected (set GUARDRAIL_PROVIDER=bedrock and BEDROCK_GUARDRAIL_ID)' },
    };
  }
  const content: GuardrailContentBlock[] = [
    ...(groundingSources || []).map(
      (s) => ({ text: { text: s, qualifiers: ['grounding_source'] } }) as GuardrailContentBlock,
    ),
    { text: { text: query, qualifiers: ['query'] } },
    { text: { text, qualifiers: ['guard_content'] } },
  ];
  try {
    const raw = await applyGuardrail('OUTPUT', content);
    const groundingFilter = extractGroundingFilters(raw).find((f) => f.type === 'GROUNDING');
    const ungroundedDetected = groundingFilter?.detected === true;
    const ungroundedPercentage =
      groundingFilter && typeof groundingFilter.score === 'number'
        ? Math.max(0, Math.min(1, 1 - groundingFilter.score))
        : 0;
    return {
      configured: true,
      ran: true,
      ungroundedDetected,
      ungroundedPercentage,
      provider: BEDROCK_GUARDRAILS_PROVIDER,
      raw,
    };
  } catch (err) {
    return {
      configured: true,
      ran: false,
      ungroundedDetected: false,
      ungroundedPercentage: 0,
      provider: BEDROCK_GUARDRAILS_PROVIDER,
      error: err instanceof Error ? err.message : String(err),
      raw: undefined,
    };
  }
}

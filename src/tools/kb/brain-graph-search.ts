/** Managed Bedrock/Neptune GraphRAG retrieval. No answer-generation model call.
 * AWS contract: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent-runtime_Retrieve.html
 * One shared graph is explicitly authorized by Matthew on 2026-09-13. Source labels
 * distinguish company and personal material; labels are not separate graph storage.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isLaneAllowed } from './search-privileged.js';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';

const REGION = 'us-east-1';
const SOURCE_ROOT = 's3://otchealth-finance-legal-dr-55c84f6b/graph-trial/20260913/managed-graphrag/';
type SourceGroup = 'company' | 'company_shared' | 'personal';
const SOURCE_PREFIXES: Record<SourceGroup, readonly string[]> = {
  company: [`${SOURCE_ROOT}company/`, `${SOURCE_ROOT}company-priority/`, `${SOURCE_ROOT}company-capacity/`],
  // CTO receives only the deliberately materialized shared projection. It must
  // never fall through to the broader company prefixes above.
  company_shared: [`${SOURCE_ROOT}company_shared/`],
  personal: [`${SOURCE_ROOT}personal/`],
};
const MAX_BYTES = 512 * 1024;
const MAX_HIT_CHARS = 3000;
const MIN_RETRIEVAL_SCORE = 0.2;
const MAX_SUSPICIOUS_TEXT_RATIO = 0.005;
type Scope = SourceGroup | 'all';
type Input = { query: string; scope?: Scope; top?: number; source_ids?: string[]; matter_id?: string; require_documentary_bridge?: boolean };
type Config = { enabled: boolean; kbId: string };
type Deps = { config(): Config; credentials(): Promise<AwsCredentials | null>; fetch: typeof fetch };
const SHA256 = /^[a-f0-9]{64}$/;
type BridgeSource = {
  source_id: string;
  source_sha256: string;
  source_version: string;
  document_name_sha256: string;
  documentary_bridge_attestation_sha256: string;
  provenance_receipt_sha256: string;
};
type Candidate = Record<string, unknown> & { bridge_source?: BridgeSource };
const DEFAULTS: Deps = {
  config: () => ({ enabled: process.env.BEDROCK_GRAPH_RETRIEVAL_ENABLED === 'true', kbId: process.env.BEDROCK_SHARED_GRAPH_KB_ID ?? '' }),
  credentials: resolveAwsCredentials,
  fetch: (...args) => fetch(...args),
};
const inputShape = {
  query: z.string().trim().min(1).max(2000).describe('Question about relationships between documents, people, organizations or events. Cite the returned sources.'),
  scope: z.enum(['company', 'company_shared', 'personal', 'all']).optional().describe('Source label filter. Company seats default to company. CTO may request only the separately materialized company_shared projection. The personal legal seat defaults to one mandatory matter-filtered personal query. Cross-group all-scope retrieval is refused.'),
  top: z.number().int().min(1).max(8).optional(),
  source_ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(5)
    .refine((ids) => new Set(ids).size === ids.length, 'Source IDs must be unique')
    .optional().describe('Narrow retrieval to up to five known canonical document IDs within your authorized scope. Use to inspect a missing source; this does not establish relationship coverage.'),
  matter_id: z.string().regex(/^personal-(?:civil|divorce)-[a-z0-9-]{3,64}$/).optional()
    .describe('Required for every personal legal retrieval. Results are intersected with this exact protected matter ID.'),
  require_documentary_bridge: z.boolean().optional()
    .describe('When true, include a hash-only documentary bridge aggregate. It is supported only by two distinct immutable returned sources with matching bridge and provenance attestations.'),
};
const inputSchema = z.object(inputShape).strict();

export function graphScopeFor(caller: string, requested?: Scope): Scope | null {
  // The CTO is intentionally not in either privileged company ring. Its only
  // GraphRAG route is the separate, ingestion-owned shared projection; omitted
  // scope deliberately remains a refusal so clients cannot gain access by
  // relying on a default.
  if (caller === 'cto') return requested === 'company_shared' ? 'company_shared' : null;
  const personalAllowed = isLaneAllowed('legal-personal', caller);
  const scope = requested ?? (personalAllowed ? 'personal' : 'company');
  if (scope === 'all') return null;
  if (scope === 'company_shared') return null;
  if (scope === 'personal') return personalAllowed ? scope : null;
  // The managed `company` label currently combines finance and company-legal material.
  // Until ingestion publishes a narrower, authenticated lane label, require the caller to
  // hold both underlying company rings. This keeps broad engineering and operations tokens
  // from turning one coarse metadata value into cross-ring access.
  if (!isLaneAllowed('finance-cfo-source-docs', caller) || !isLaneAllowed('legal-company', caller)) return null;
  return scope;
}

function documentaryBridge(records: Candidate[]): Record<string, unknown> {
  const groups = new Map<string, BridgeSource[]>();
  for (const record of records) {
    const source = record.bridge_source;
    if (!source) continue;
    const key = `${source.documentary_bridge_attestation_sha256}:${source.provenance_receipt_sha256}`;
    const group = groups.get(key);
    if (group) group.push(source); else groups.set(key, [source]);
  }
  for (const sources of groups.values()) {
    const sourceIds = new Set(sources.map((source) => source.source_id));
    const sourceHashes = new Set(sources.map((source) => source.source_sha256));
    const sourceVersions = new Set(sources.map((source) => source.source_version));
    const documentNameHashes = new Set(sources.map((source) => source.document_name_sha256));
    if (sourceIds.size < 2 || sourceHashes.size < 2 || sourceVersions.size < 2 || documentNameHashes.size < 2) continue;
    const witness = sources.find((source) =>
      [...sources].filter((other) => other.source_id !== source.source_id && other.source_sha256 !== source.source_sha256 && other.source_version !== source.source_version && other.document_name_sha256 !== source.document_name_sha256).length > 0,
    );
    if (!witness) continue;
    return {
      status: 'supported', qualifying_source_count: Math.min(sources.length, 8),
      documentary_bridge_attestation_sha256: witness.documentary_bridge_attestation_sha256,
      provenance_receipt_sha256: witness.provenance_receipt_sha256,
    };
  }
  return { status: 'unproven' };
}

function outcome(mode: string, error?: string, requireDocumentaryBridge = false): ToolResultPayload {
  return { data: { mode, matches: [], count: 0, ...(error ? { error } : {}), ...(requireDocumentaryBridge ? { documentary_bridge: { status: 'unproven' } } : {}) }, summary: `Managed GraphRAG retrieval: ${mode}.` };
}

function isAllowedSourceUri(group: SourceGroup, uri: string): boolean {
  return SOURCE_PREFIXES[group].some((prefix) => uri.startsWith(prefix)) && /\.txt$/.test(uri);
}

const STOP_WORDS = new Set(['about', 'after', 'again', 'also', 'and', 'are', 'between', 'did', 'does', 'for', 'from', 'has', 'have', 'how', 'into', 'its', 'not', 'only', 'that', 'the', 'their', 'then', 'this', 'through', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'with']);

function meaningfulTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])]
    .filter((term) => !STOP_WORDS.has(term));
}

export function hasMeaningfulOverlap(query: string, text: string): boolean {
  const terms = meaningfulTerms(query);
  if (!terms.length) return false;
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

export function isCleanRetrievedText(text: string): boolean {
  if (!text.trim() || text.includes('\u0000')) return false;
  let suspicious = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (character === '\ufffd' || (code < 32 && character !== '\n' && character !== '\r' && character !== '\t')) suspicious++;
  }
  return suspicious / Math.max(1, text.length) <= MAX_SUSPICIOUS_TEXT_RATIO;
}

async function readBounded(response: Response): Promise<unknown> {
  const stated = Number(response.headers.get('content-length') ?? '0');
  if (!Number.isFinite(stated) || stated > MAX_BYTES) throw new Error('response_size');
  if (!response.body) throw new Error('response_body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new Error('response_size');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function handleBrainGraphSearch(input: Input, ctx: ToolContext, deps: Deps = DEFAULTS): Promise<ToolResultPayload> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return outcome('invalid_request', 'invalid_input');
  const requireDocumentaryBridge = parsed.data.require_documentary_bridge === true;
  const scope = graphScopeFor(ctx.callerAgent, parsed.data.scope);
  if (!scope) return outcome('forbidden', 'forbidden_ring', requireDocumentaryBridge);
  if (scope === 'personal' && !parsed.data.matter_id) return outcome('invalid_request', 'matter_id_required', requireDocumentaryBridge);
  if (scope !== 'personal' && parsed.data.matter_id) return outcome('invalid_request', 'matter_id_not_allowed', requireDocumentaryBridge);
  const config = deps.config();
  if (!config.enabled) return outcome('not_enabled', undefined, requireDocumentaryBridge);
  if (!/^[A-Za-z0-9]{10}$/.test(config.kbId)) return outcome('unconfigured', 'invalid_knowledge_base_configuration', requireDocumentaryBridge);
  const credentials = await deps.credentials();
  if (!credentials) return outcome('unavailable', 'credentials_unavailable', requireDocumentaryBridge);
  const top = parsed.data.top ?? 5;
  const requestedSources = parsed.data.source_ids ? new Set(parsed.data.source_ids) : undefined;
  const sourceFilter = requestedSources ? { in: { key: 'source_id', value: [...requestedSources] } } : undefined;
  const groupFilter = { equals: { key: 'source_group', value: scope } };
  const matterFilter = parsed.data.matter_id ? { equals: { key: 'matter_id', value: parsed.data.matter_id } } : undefined;
  // Source narrowing is intersected with the authenticated scope, never substituted
  // for it. Repeat the source-ID check on returned rows if upstream ignores a filter.
  const filters = [groupFilter, matterFilter, sourceFilter].filter((value) => value !== undefined);
  const filter = filters.length === 1 ? filters[0] : { andAll: filters };
  const host = `bedrock-agent-runtime.${REGION}.amazonaws.com`;
  const path = `/knowledgebases/${config.kbId}/retrieve`;
  const body = JSON.stringify({
    retrievalQuery: { text: parsed.data.query },
    retrievalConfiguration: { vectorSearchConfiguration: {
      numberOfResults: top,
      ...(filter ? { filter } : {}),
    } },
  });
  const signed = signRequest({ method: 'POST', host, path, body, region: REGION, service: 'bedrock', credentials });
  try {
    const response = await deps.fetch(`https://${host}${path}`, { method: 'POST', headers: signed.headers, body, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return outcome('unavailable', `bedrock_http_${response.status}`);
    }
    const raw: any = await readBounded(response);
    if (raw?.guardrailAction === 'INTERVENED') return outcome('withheld', 'retrieval_intervened');
    if (!Array.isArray(raw?.retrievalResults) || raw.retrievalResults.length > 100) return outcome('unavailable', 'invalid_bedrock_response');
    const candidates: Candidate[] = [];
    let withheld = 0;
    let qualityWithheld = 0;
    let relevanceWithheld = 0;
    for (const row of raw.retrievalResults.slice(0, top)) {
      const uri = row?.location?.type === 'S3' ? row?.location?.s3Location?.uri : undefined;
      const group = row?.metadata?.source_group;
      const text = row?.content?.text;
      // Require both the owner-written label and the fixed ingestion location. No URL
      // from a model result is fetched, and arbitrary metadata is never copied onward.
      if ((group !== 'company' && group !== 'company_shared' && group !== 'personal') || (scope !== 'all' && group !== scope) || typeof uri !== 'string' || uri.length > 1200 || !isAllowedSourceUri(group, uri) || typeof text !== 'string' || !text.trim()) { withheld++; continue; }
      const sourceId = row?.metadata?.source_id;
      const textHash = row?.metadata?.text_sha256;
      const matterId = row?.metadata?.matter_id;
      const sourceHash = row?.metadata?.source_sha256;
      const sourceVersion = row?.metadata?.source_version;
      const documentNameHash = row?.metadata?.document_name_sha256;
      const bridgeAttestationHash = row?.metadata?.documentary_bridge_attestation_sha256;
      const provenanceReceiptHash = row?.metadata?.provenance_receipt_sha256;
      if (requestedSources && (typeof sourceId !== 'string' || !requestedSources.has(sourceId))) { withheld++; continue; }
      if (scope === 'personal' && matterId !== parsed.data.matter_id) { withheld++; continue; }
      if (!isCleanRetrievedText(text)) { qualityWithheld++; continue; }
      const score = typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : undefined;
      if (!requestedSources && (score === undefined || score < MIN_RETRIEVAL_SCORE || !hasMeaningfulOverlap(parsed.data.query, text))) { relevanceWithheld++; continue; }
      candidates.push({
        source_group: group, source_uri: uri,
        ...(typeof sourceId === 'string' && SHA256.test(sourceId) ? { source_id: sourceId } : {}),
        ...(typeof textHash === 'string' && SHA256.test(textHash) ? { text_sha256: textHash } : {}),
        ...(typeof matterId === 'string' ? { matter_id: matterId } : {}),
        ...(typeof row?.metadata?.source_version === 'string' ? { source_version: row.metadata.source_version } : {}),
        ...(typeof sourceHash === 'string' && SHA256.test(sourceHash) ? { source_sha256: sourceHash } : {}),
        ...(typeof sourceId === 'string' && SHA256.test(sourceId) && typeof sourceHash === 'string' && SHA256.test(sourceHash) && sourceVersion === `sha256:${sourceHash}` && typeof documentNameHash === 'string' && SHA256.test(documentNameHash) && typeof bridgeAttestationHash === 'string' && SHA256.test(bridgeAttestationHash) && typeof provenanceReceiptHash === 'string' && SHA256.test(provenanceReceiptHash) ? { bridge_source: { source_id: sourceId, source_sha256: sourceHash, source_version: sourceVersion, document_name_sha256: documentNameHash, documentary_bridge_attestation_sha256: bridgeAttestationHash, provenance_receipt_sha256: provenanceReceiptHash } } : {}),
        text: text.slice(0, MAX_HIT_CHARS), truncated: text.length > MAX_HIT_CHARS,
        ...(score !== undefined ? { retrieval_score: score } : {}),
      });
    }
    const seenText = new Set<string>();
    let duplicateWithheld = 0;
    const matches = candidates.filter((match) => {
      const key = typeof match.text_sha256 === 'string' ? match.text_sha256 : undefined;
      if (!key || !seenText.has(key)) { if (key) seenText.add(key); return true; }
      duplicateWithheld++;
      return false;
    });
    const bridge = requireDocumentaryBridge ? documentaryBridge(matches) : undefined;
    const returnedMatches = matches.map(({ bridge_source: _bridgeSource, ...match }, index) => ({ citation: `graph:${index + 1}`, ...match }));
    return {
      data: { mode: 'aws-managed-graphrag', scope, matches: returnedMatches, count: returnedMatches.length, withheld_count: withheld, quality_withheld_count: qualityWithheld, relevance_withheld_count: relevanceWithheld, duplicate_withheld_count: duplicateWithheld, answer_generated: false, ...(bridge ? { documentary_bridge: bridge } : {}), ...(parsed.data.matter_id ? { matter_id: parsed.data.matter_id, matter_filter_applied: true } : {}), ...(requestedSources ? { source_filter_applied: true, requested_source_count: requestedSources.size } : {}), ...(raw.nextToken ? { more_results_available: true } : {}) },
      summary: `${returnedMatches.length} source-cited GraphRAG passages. The shared graph can contain inferred relationships; a retrieval score does not prove a fact or causation.`,
    };
  } catch { return outcome('unavailable', 'bedrock_retrieval_failed'); }
}

export function registerBrainGraphSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'brain_graph_search', category: 'read',
    annotations: {
      title: 'Search document connections using AWS GraphRAG',
      description: 'Retrieve source-cited relationship context from AWS Bedrock GraphRAG. Read-only, no generated answer. Personal legal retrieval requires one exact matter_id and refuses all-scope searches. Results are locally checked for ring, matter, clean text, meaningful query overlap, and duplicate text hashes. Returns not_enabled or unavailable honestly when the service is not ready. Cite sources and distinguish evidence from inference.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape,
    outputShape: { mode: z.string(), matches: z.array(z.unknown()), count: z.number(), error: z.string().optional(), scope: z.string().optional(), matter_id: z.string().optional(), matter_filter_applied: z.boolean().optional(), withheld_count: z.number().optional(), quality_withheld_count: z.number().optional(), relevance_withheld_count: z.number().optional(), duplicate_withheld_count: z.number().optional(), answer_generated: z.boolean().optional(), more_results_available: z.boolean().optional(), source_filter_applied: z.boolean().optional(), requested_source_count: z.number().optional(), documentary_bridge: z.object({ status: z.enum(['supported', 'unproven']), qualifying_source_count: z.number().optional(), documentary_bridge_attestation_sha256: z.string().optional(), provenance_receipt_sha256: z.string().optional() }).optional() },
    redactInputForLog: (input) => ({ query_redacted: true, scope: input.scope, matter_id: input.matter_id, top: input.top, ...(input.require_documentary_bridge === true ? { require_documentary_bridge: true } : {}), ...(Array.isArray(input.source_ids) ? { source_id_count: input.source_ids.length } : {}) }),
    handler: (input, ctx) => handleBrainGraphSearch(input, ctx),
  }, callerHash);
}

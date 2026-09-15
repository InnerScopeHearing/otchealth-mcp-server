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
const SOURCE_PREFIXES: Record<'company' | 'personal', readonly string[]> = {
  company: [`${SOURCE_ROOT}company/`, `${SOURCE_ROOT}company-priority/`, `${SOURCE_ROOT}company-capacity/`],
  personal: [`${SOURCE_ROOT}personal/`],
};
const MAX_BYTES = 512 * 1024;
const MAX_HIT_CHARS = 3000;
type Scope = 'company' | 'personal' | 'all';
type Input = { query: string; scope?: Scope; top?: number; source_ids?: string[] };
type Config = { enabled: boolean; kbId: string };
type Deps = { config(): Config; credentials(): Promise<AwsCredentials | null>; fetch: typeof fetch };
const DEFAULTS: Deps = {
  config: () => ({ enabled: process.env.BEDROCK_GRAPH_RETRIEVAL_ENABLED === 'true', kbId: process.env.BEDROCK_SHARED_GRAPH_KB_ID ?? '' }),
  credentials: resolveAwsCredentials,
  fetch: (...args) => fetch(...args),
};
const inputShape = {
  query: z.string().trim().min(1).max(2000).describe('Question about relationships between documents, people, organizations or events. Cite the returned sources.'),
  scope: z.enum(['company', 'personal', 'all']).optional().describe('Source label filter. Company seats default to company. The personal legal seat may query the shared corpus.'),
  top: z.number().int().min(1).max(8).optional(),
  source_ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(5)
    .refine((ids) => new Set(ids).size === ids.length, 'Source IDs must be unique')
    .optional().describe('Narrow retrieval to up to five known canonical document IDs within your authorized scope. Use to inspect a missing source; this does not establish relationship coverage.'),
};
const inputSchema = z.object(inputShape).strict();

export function graphScopeFor(caller: string, requested?: Scope): Scope | null {
  // The managed `company` label currently combines finance and company-legal material.
  // Until ingestion publishes a narrower, authenticated lane label, require the caller to
  // hold both underlying company rings. This keeps broad engineering and operations tokens
  // from turning one coarse metadata value into cross-ring access.
  if (!isLaneAllowed('finance-cfo-source-docs', caller) || !isLaneAllowed('legal-company', caller)) return null;
  const personalAllowed = isLaneAllowed('legal-personal', caller);
  const scope = requested ?? (personalAllowed ? 'all' : 'company');
  return scope !== 'company' && !personalAllowed ? null : scope;
}

function outcome(mode: string, error?: string): ToolResultPayload {
  return { data: { mode, matches: [], count: 0, ...(error ? { error } : {}) }, summary: `Managed GraphRAG retrieval: ${mode}.` };
}

function isAllowedSourceUri(group: 'company' | 'personal', uri: string): boolean {
  return SOURCE_PREFIXES[group].some((prefix) => uri.startsWith(prefix)) && /\.txt$/.test(uri);
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
  const scope = graphScopeFor(ctx.callerAgent, parsed.data.scope);
  if (!scope) return outcome('forbidden', 'forbidden_ring');
  const config = deps.config();
  if (!config.enabled) return outcome('not_enabled');
  if (!/^[A-Za-z0-9]{10}$/.test(config.kbId)) return outcome('unconfigured', 'invalid_knowledge_base_configuration');
  const credentials = await deps.credentials();
  if (!credentials) return outcome('unavailable', 'credentials_unavailable');
  const top = parsed.data.top ?? 5;
  const requestedSources = parsed.data.source_ids ? new Set(parsed.data.source_ids) : undefined;
  const sourceFilter = requestedSources ? { in: { key: 'source_id', value: [...requestedSources] } } : undefined;
  const groupFilter = scope === 'all' ? undefined : { equals: { key: 'source_group', value: scope } };
  // Source narrowing is intersected with the authenticated scope, never substituted
  // for it. Repeat the source-ID check on returned rows if upstream ignores a filter.
  const filter = groupFilter && sourceFilter ? { andAll: [groupFilter, sourceFilter] } : groupFilter ?? sourceFilter;
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
    const matches: Array<Record<string, unknown>> = [];
    let withheld = 0;
    for (const row of raw.retrievalResults.slice(0, top)) {
      const uri = row?.location?.type === 'S3' ? row?.location?.s3Location?.uri : undefined;
      const group = row?.metadata?.source_group;
      const text = row?.content?.text;
      // Require both the owner-written label and the fixed ingestion location. No URL
      // from a model result is fetched, and arbitrary metadata is never copied onward.
      if ((group !== 'company' && group !== 'personal') || (scope !== 'all' && group !== scope) || typeof uri !== 'string' || uri.length > 1200 || !isAllowedSourceUri(group, uri) || typeof text !== 'string' || !text.trim()) { withheld++; continue; }
      const sourceId = row?.metadata?.source_id;
      const textHash = row?.metadata?.text_sha256;
      if (requestedSources && (typeof sourceId !== 'string' || !requestedSources.has(sourceId))) { withheld++; continue; }
      matches.push({
        citation: `graph:${matches.length + 1}`, source_group: group, source_uri: uri,
        ...(typeof sourceId === 'string' && /^[a-f0-9]{64}$/.test(sourceId) ? { source_id: sourceId } : {}),
        ...(typeof textHash === 'string' && /^[a-f0-9]{64}$/.test(textHash) ? { text_sha256: textHash } : {}),
        text: text.slice(0, MAX_HIT_CHARS), truncated: text.length > MAX_HIT_CHARS,
        ...(typeof row.score === 'number' && Number.isFinite(row.score) ? { retrieval_score: row.score } : {}),
      });
    }
    return {
      data: { mode: 'aws-managed-graphrag', scope, matches, count: matches.length, withheld_count: withheld, answer_generated: false, ...(requestedSources ? { source_filter_applied: true, requested_source_count: requestedSources.size } : {}), ...(raw.nextToken ? { more_results_available: true } : {}) },
      summary: `${matches.length} source-cited GraphRAG passages. The shared graph can contain inferred relationships; a retrieval score does not prove a fact or causation.`,
    };
  } catch { return outcome('unavailable', 'bedrock_retrieval_failed'); }
}

export function registerBrainGraphSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'brain_graph_search', category: 'read',
    annotations: {
      title: 'Search document connections using AWS GraphRAG',
      description: 'Retrieve source-cited relationship context from the shared AWS Bedrock/Neptune graph. Read-only, no generated answer. Respects authenticated role and source labels. Company and personal legal documents share graph storage by owner instruction; source filters are not physically separate graphs. Returns not_enabled or unavailable honestly when the service is not ready. Query this when asking how X relates to Y or Z, then cite sources and distinguish evidence from inference.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape,
    outputShape: { mode: z.string(), matches: z.array(z.unknown()), count: z.number(), error: z.string().optional(), scope: z.string().optional(), withheld_count: z.number().optional(), answer_generated: z.boolean().optional(), more_results_available: z.boolean().optional(), source_filter_applied: z.boolean().optional(), requested_source_count: z.number().optional() },
    redactInputForLog: (input) => ({ query_redacted: true, scope: input.scope, top: input.top, ...(Array.isArray(input.source_ids) ? { source_id_count: input.source_ids.length } : {}) }),
    handler: (input, ctx) => handleBrainGraphSearch(input, ctx),
  }, callerHash);
}

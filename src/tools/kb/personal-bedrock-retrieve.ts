/** CLO Personal-only native Bedrock Retrieve against the already-ingested personal datasource. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';

const REGION = 'us-east-1';
const KNOWLEDGE_BASE_ID = 'XNMHPUKGDT';
const DATA_SOURCE_ID = 'KJLMR9R8P5';
const SOURCE_PREFIX = 's3://otchealth-finance-legal-dr-55c84f6b/graph-trial/20260913/managed-graphrag/personal/';
const MAX_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 8000;
const MAX_QUERY_CHARS = 2000;
const SHA256 = /^[a-f0-9]{64}$/;

type Input = { query: string; top?: number };
type Config = { enabled: boolean; kbId: string };
type Deps = { config(): Config; credentials(): Promise<AwsCredentials | null>; fetch: typeof fetch };
const DEFAULTS: Deps = {
  config: () => ({
    enabled: process.env.BEDROCK_GRAPH_RETRIEVAL_ENABLED === 'true',
    kbId: process.env.BEDROCK_SHARED_GRAPH_KB_ID ?? '',
  }),
  credentials: resolveAwsCredentials,
  fetch: (...args) => fetch(...args),
};
const inputShape = {
  query: z.string().trim().min(1).max(MAX_QUERY_CHARS).describe('Search the existing CLO Personal source collection. Do not include unrelated company, finance, or patient data.'),
  top: z.number().int().min(1).max(8).optional().describe('Maximum number of cited source passages, default 5.'),
};
const inputSchema = z.object(inputShape).strict();

function outcome(mode: string, error?: string): ToolResultPayload {
  return { data: { mode, matches: [], count: 0, ...(error ? { error } : {}) }, summary: `CLO Personal Bedrock retrieval: ${mode}.` };
}

async function readBounded(response: Response): Promise<unknown> {
  const stated = Number(response.headers.get('content-length') ?? '0');
  if (!Number.isFinite(stated) || stated > MAX_BYTES || !response.body) throw new Error('response_size');
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

type CitationRow = {
  citation: string;
  source_group: 'personal';
  source_uri: string;
  source_id: string;
  source_version: string;
  source_sha256?: string;
  text_sha256?: string;
  data_source_id: string;
  chunk_id: string;
  text: string;
  truncated: boolean;
  retrieval_score?: number;
};

function citationRow(row: any): CitationRow | null {
  const metadata = row?.metadata;
  const uri = row?.location?.type === 'S3' ? row.location.s3Location?.uri : undefined;
  const sourceId = metadata?.source_id;
  const sourceVersion = metadata?.source_version;
  const dataSourceId = metadata?.['x-amz-bedrock-kb-data-source-id'];
  const chunkId = metadata?.['x-amz-bedrock-kb-chunk-id'];
  const text = row?.content?.text;
  if (metadata?.source_group !== 'personal' ||
      dataSourceId !== DATA_SOURCE_ID || typeof uri !== 'string' || uri.length > 1200 ||
      !uri.startsWith(SOURCE_PREFIX) ||
      typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.length > 256 ||
      typeof sourceVersion !== 'string' || sourceVersion.length === 0 || sourceVersion.length > 256 ||
      typeof chunkId !== 'string' || chunkId.length === 0 || chunkId.length > 512 ||
      typeof text !== 'string' || !text.trim()) return null;
  const sourceHash = metadata?.source_sha256;
  const textHash = metadata?.text_sha256;
  return {
    citation: `bedrock-personal:${DATA_SOURCE_ID}:${sourceId}:${chunkId}`,
    source_group: 'personal', source_uri: uri, source_id: sourceId, source_version: sourceVersion,
    ...(typeof sourceHash === 'string' && SHA256.test(sourceHash) ? { source_sha256: sourceHash } : {}),
    ...(typeof textHash === 'string' && SHA256.test(textHash) ? { text_sha256: textHash } : {}),
    data_source_id: DATA_SOURCE_ID, chunk_id: chunkId,
    text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS,
    ...(typeof row.score === 'number' && Number.isFinite(row.score) ? { retrieval_score: row.score } : {}),
  };
}

export async function handlePersonalBedrockRetrieve(input: Input, ctx: ToolContext, deps: Deps = DEFAULTS): Promise<ToolResultPayload> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return outcome('invalid_request', 'invalid_input');
  if (ctx.callerAgent !== 'clo-personal') return outcome('forbidden', 'forbidden_ring');
  const config = deps.config();
  if (!config.enabled) return outcome('not_enabled');
  if (config.kbId !== KNOWLEDGE_BASE_ID) return outcome('unconfigured', 'personal_knowledge_base_not_configured');
  let credentials: AwsCredentials | null;
  try { credentials = await deps.credentials(); } catch { return outcome('unavailable', 'credentials_unavailable'); }
  if (!credentials) return outcome('unavailable', 'credentials_unavailable');

  const host = `bedrock-agent-runtime.${REGION}.amazonaws.com`;
  const path = `/knowledgebases/${KNOWLEDGE_BASE_ID}/retrieve`;
  // Two independent fixed filters are ANDed: user input cannot broaden either ring or source.
  const body = JSON.stringify({
    retrievalQuery: { text: parsed.data.query },
    retrievalConfiguration: { vectorSearchConfiguration: {
      numberOfResults: parsed.data.top ?? 5,
      filter: { andAll: [
        { equals: { key: 'source_group', value: 'personal' } },
        { equals: { key: 'x-amz-bedrock-kb-data-source-id', value: DATA_SOURCE_ID } },
      ] },
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
    const matches = raw.retrievalResults.map(citationRow);
    // Refuse the entire page if the provider returns even one row outside the fixed personal lane.
    if (matches.some((match: CitationRow | null) => match === null)) return outcome('withheld', 'invalid_or_uncited_source');
    return {
      data: { mode: 'aws-bedrock-personal-retrieve', scope: 'personal', matches, count: matches.length, evidence_status: 'candidate_excerpts_only', answer_generated: false, graph_traversal_proven: false },
      summary: `${matches.length} candidate excerpts from the fixed CLO Personal datasource, each carrying the provider source URI, source version, datasource ID, and chunk ID. Retrieval does not prove a graph traversal or legal conclusion.`,
    };
  } catch { return outcome('unavailable', 'bedrock_retrieval_failed'); }
}

export function registerPersonalBedrockRetrieve(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'personal_bedrock_retrieve', category: 'read',
    annotations: {
      title: 'Retrieve cited CLO Personal passages from AWS Bedrock',
      description: 'CLO Personal only. Read-only native Bedrock Retrieve over the fixed existing personal datasource. Both personal source-group and fixed datasource filters are always applied. Every result is checked against the datasource, personal metadata and fixed S3 prefix. Returns provider source, version and chunk citations. Candidate excerpts do not prove a graph traversal or legal conclusion.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape,
    outputShape: { mode: z.string(), matches: z.array(z.unknown()), count: z.number(), error: z.string().optional(), scope: z.string().optional(), evidence_status: z.string().optional(), answer_generated: z.boolean().optional(), graph_traversal_proven: z.boolean().optional() },
    redactInputForLog: (input) => ({ query_redacted: true, top: input.top }),
    handler: (input, ctx) => handlePersonalBedrockRetrieve(input, ctx),
  }, callerHash);
}

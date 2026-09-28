/** Fixed public-only retrieval from the dedicated Bedrock company_shared KB. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';

const REGION = 'us-east-1';
const ALLOWED_KB_ID = 'ZAYEKIX0RX';
const SOURCE_PREFIX = 's3://otchealth-finance-legal-dr-55c84f6b/graph-trial/20260913/managed-graphrag/company_shared/';
const APPROVED_SOURCES = new Map([
  ['1ab094b6006bcc487b3e2e78f655ebc0c6628e20ce331a21372cc3c9486b9064', 'https://otchealthmart.com/pages/about-us'],
  ['cf198fd8021dfc909fb53778019cf5aaf22b764b4d493ff9993065fdb13b83d6', 'https://otchealthmart.com/collections/treo-by-ihear'],
]);
const MAX_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 3000;
const COMPANY_SEATS = new Set(['cto', 'cfo', 'clo', 'coo', 'cro', 'developer']);

type Input = { query: string; top?: number };
type Config = { kbId?: string };
type Deps = { config(): Config; credentials(): Promise<AwsCredentials | null>; fetch: typeof fetch };
const DEFAULTS: Deps = {
  config: () => ({ kbId: process.env.BEDROCK_PUBLIC_KB_ID }),
  credentials: resolveAwsCredentials,
  fetch: (...args) => fetch(...args),
};
const inputShape = {
  query: z.string().trim().min(1).max(2000).describe('Search the approved public company_shared knowledge base.'),
  top: z.number().int().min(1).max(8).optional(),
};
const inputSchema = z.object(inputShape).strict();

function outcome(mode: string, error?: string): ToolResultPayload {
  return { data: { mode, matches: [], count: 0, ...(error ? { error } : {}) }, summary: `Public knowledge base retrieval: ${mode}.` };
}

export function isCompanySeat(caller: string | undefined | null): boolean {
  return typeof caller === 'string' && COMPANY_SEATS.has(caller);
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

function safeCitationRow(row: any): { citation: string; source_id: string; source_uri: string; source_url: string; text: string; truncated: boolean; retrieval_score?: number } | null {
  const uri = row?.location?.type === 'S3' ? row?.location?.s3Location?.uri : undefined;
  if (typeof uri !== 'string' || uri.length > 1200 || !uri.startsWith(SOURCE_PREFIX)) return null;
  const relative = uri.slice(SOURCE_PREFIX.length);
  const match = /^([a-f0-9]{64})\.txt$/.exec(relative);
  if (!match) return null;
  // The approved corpus has no custom metadata sidecars. Derive identity only from its content hash filename.
  const sourceId = match[1];
  const sourceUrl = APPROVED_SOURCES.get(sourceId!);
  if (!sourceUrl) return null;
  const text = row?.content?.text;
  if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 256 || typeof text !== 'string' || !text.trim()) return null;
  return {
    citation: `public-kb:${sourceId}`,
    source_id: sourceId,
    source_uri: uri,
    source_url: sourceUrl,
    text: text.slice(0, MAX_TEXT_CHARS),
    truncated: text.length > MAX_TEXT_CHARS,
    ...(typeof row?.score === 'number' && Number.isFinite(row.score) ? { retrieval_score: row.score } : {}),
  };
}

export async function handleBrainPublicKbSearch(input: Input, ctx: ToolContext, deps: Deps = DEFAULTS): Promise<ToolResultPayload> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return outcome('invalid_request', 'invalid_input');
  if (!isCompanySeat(ctx.callerAgent)) return outcome('forbidden', 'company_seat_required');
  const kbId = deps.config().kbId;
  if (kbId !== ALLOWED_KB_ID) return outcome('unconfigured', 'public_knowledge_base_not_configured');
  const credentials = await deps.credentials();
  if (!credentials) return outcome('unavailable', 'credentials_unavailable');

  const host = `bedrock-agent-runtime.${REGION}.amazonaws.com`;
  const path = `/knowledgebases/${ALLOWED_KB_ID}/retrieve`;
  const body = JSON.stringify({
    retrievalQuery: { text: parsed.data.query },
    retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: parsed.data.top ?? 5 } },
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
    const matches = raw.retrievalResults.map(safeCitationRow);
    // The entire response is refused if even one row leaves the public prefix or lacks its citation.
    if (matches.some((match: ReturnType<typeof safeCitationRow>) => match === null)) return outcome('withheld', 'invalid_or_uncited_source');
    return {
      data: { mode: 'aws-bedrock-public-company-shared', scope: 'company_shared', matches, count: matches.length, evidence_status: 'candidate_excerpts_only', answer_generated: false },
      summary: `${matches.length} candidate excerpts from the fixed public company_shared knowledge base. Retrieval scores do not establish relevance; any answer must be directly supported by cited excerpt text.`,
    };
  } catch { return outcome('unavailable', 'bedrock_retrieval_failed'); }
}

export function registerBrainPublicKbSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'brain_public_kb_search', category: 'read',
    annotations: {
      title: 'Search public company_shared knowledge base',
      description: 'Read-only retrieval from the fixed public-only Bedrock Knowledge Base. Available to authenticated company seats. Every result must cite an S3 source under the approved company_shared public prefix; any missing or unexpected citation withholds the whole response. Results are candidate excerpts only: retrieval scores do not prove relevance, and an answer must be directly supported by cited text. No answer generation or write API.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape,
    outputShape: { mode: z.string(), matches: z.array(z.unknown()), count: z.number(), error: z.string().optional(), scope: z.string().optional(), evidence_status: z.string().optional(), answer_generated: z.boolean().optional() },
    redactInputForLog: () => ({ query_redacted: true }),
    handler: (input, ctx) => handleBrainPublicKbSearch(input, ctx),
  }, callerHash);
}

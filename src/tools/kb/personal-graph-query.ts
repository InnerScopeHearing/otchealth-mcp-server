/** Exact, provenance-bearing reads over the protected CLO Personal Neptune graph. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';

const REGION = 'us-east-1';
const HOST = `neptune-graph.${REGION}.amazonaws.com`;
const PATH = '/queries';
const MAX_BYTES = 512 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const MATTER = /^personal-(?:civil|divorce)-[a-z0-9-]{3,64}$/;
const PAIR_QUERY = `
MATCH (left:PersonalLegalEntity {matter_sha256: $matter_sha256, entity_sha256: $left_entity_id})
      -[edge:SOURCE_EVIDENCED {matter_sha256: $matter_sha256}]->
      (right:PersonalLegalEntity {matter_sha256: $matter_sha256, entity_sha256: $right_entity_id})
RETURN edge.edge_id AS edge_id, edge.predicate_sha256 AS predicate_sha256,
       edge.document_sha256 AS document_sha256, edge.source_sha256 AS source_sha256,
       edge.anchor_sha256 AS anchor_sha256, edge.locator_sha256 AS locator_sha256,
       edge.status AS status, edge.reviewer_sha256 AS reviewer_sha256
ORDER BY edge.edge_id
LIMIT 25`.trim();

type Input = { matter_id: string; x_entity_id: string; y_entity_id: string; z_entity_id: string };
type Config = { enabled: boolean; graphId: string };
type Deps = { config(): Config; credentials(): Promise<AwsCredentials | null>; fetch: typeof fetch };
const DEFAULTS: Deps = {
  config: () => ({ enabled: process.env.NEPTUNE_PERSONAL_GRAPH_ENABLED === 'true', graphId: process.env.NEPTUNE_PERSONAL_GRAPH_ID ?? '' }),
  credentials: resolveAwsCredentials,
  fetch: (...args) => fetch(...args),
};
const inputShape = {
  matter_id: z.string().regex(MATTER).describe('Exact protected legal matter ID. Required and enforced on every node and edge.'),
  x_entity_id: z.string().regex(SHA).describe('Matter-scoped opaque SHA-256 identifier for X. Do not provide names or source text.'),
  y_entity_id: z.string().regex(SHA).describe('Matter-scoped opaque SHA-256 identifier for Y. Do not provide names or source text.'),
  z_entity_id: z.string().regex(SHA).describe('Matter-scoped opaque SHA-256 identifier for Z. Do not provide names or source text.'),
};
const inputSchema = z.object(inputShape).strict();

function outcome(mode: string, error?: string): ToolResultPayload {
  return { data: { mode, complete_chain: false, x_y: [], y_z: [], x_z: [], ...(error ? { error } : {}) }, summary: `Protected personal graph traversal: ${mode}.` };
}

async function readBounded(response: Response): Promise<unknown> {
  const stated = Number(response.headers.get('content-length') ?? '0');
  if (!Number.isFinite(stated) || stated > MAX_BYTES || !response.body) throw new Error('response_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new Error('response_invalid');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validEdge(row: unknown): row is Record<string, string> {
  if (!row || typeof row !== 'object') return false;
  const value = row as Record<string, unknown>;
  const strings = ['edge_id', 'predicate_sha256', 'document_sha256', 'source_sha256', 'anchor_sha256', 'locator_sha256', 'status', 'reviewer_sha256'];
  return strings.every((key) => typeof value[key] === 'string' && value[key] !== '')
    && SHA.test(String(value.predicate_sha256)) && SHA.test(String(value.document_sha256))
    && SHA.test(String(value.source_sha256)) && SHA.test(String(value.anchor_sha256))
    && SHA.test(String(value.locator_sha256)) && SHA.test(String(value.reviewer_sha256));
}

function hashMatterId(matterId: string): string {
  return createHash('sha256').update(matterId, 'utf8').digest('hex');
}

async function pair(graphId: string, credentials: AwsCredentials, deps: Deps, matterSha256: string, leftEntityId: string, rightEntityId: string): Promise<Record<string, string>[]> {
  const body = JSON.stringify({ language: 'OPEN_CYPHER', query: PAIR_QUERY, parameters: { matter_sha256: matterSha256, left_entity_id: leftEntityId, right_entity_id: rightEntityId }, planCache: 'AUTO', queryTimeoutMilliseconds: 10_000 });
  const signed = signRequest({ method: 'POST', host: HOST, path: PATH, body, region: REGION, service: 'neptune-graph', credentials, extraHeaders: { graphidentifier: graphId } });
  const response = await deps.fetch(`https://${HOST}${PATH}`, { method: 'POST', headers: signed.headers, body, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error('neptune_http'); }
  const raw = await readBounded(response) as { results?: unknown[] };
  if (!Array.isArray(raw?.results) || raw.results.length > 25 || !raw.results.every(validEdge)) throw new Error('neptune_response');
  return raw.results as Record<string, string>[];
}

export async function handlePersonalGraphQuery(input: Input, ctx: ToolContext, deps: Deps = DEFAULTS): Promise<ToolResultPayload> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return outcome('invalid_request', 'invalid_input');
  if (ctx.callerAgent !== 'clo-personal') return outcome('forbidden', 'forbidden_ring');
  const config = deps.config();
  if (!config.enabled) return outcome('not_enabled');
  if (!/^g-[a-z0-9]{10}$/.test(config.graphId)) return outcome('unconfigured', 'invalid_graph_configuration');
  const credentials = await deps.credentials();
  if (!credentials) return outcome('unavailable', 'credentials_unavailable');
  try {
    const matterSha256 = hashMatterId(parsed.data.matter_id);
    const [xY, yZ, xZ] = await Promise.all([
      pair(config.graphId, credentials, deps, matterSha256, parsed.data.x_entity_id, parsed.data.y_entity_id),
      pair(config.graphId, credentials, deps, matterSha256, parsed.data.y_entity_id, parsed.data.z_entity_id),
      pair(config.graphId, credentials, deps, matterSha256, parsed.data.x_entity_id, parsed.data.z_entity_id),
    ]);
    const complete = xY.length > 0 && yZ.length > 0;
    return {
      data: { mode: 'aws-neptune-provenance-graph', matter_id: parsed.data.matter_id, complete_scan: true, complete_chain: complete, direct_x_z_present: xZ.length > 0, x_y: xY, y_z: yZ, x_z: xZ },
      summary: `Protected traversal ${complete ? 'proved' : 'not proved'} by explicit source-evidenced edges. Co-occurrence is not liability, causation, ownership, intent, or a merits finding.`,
    };
  } catch { return outcome('unavailable', 'neptune_query_failed'); }
}

export function registerPersonalGraphQuery(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'personal_graph_query', category: 'read',
    annotations: {
      title: 'Query protected personal legal graph edges',
      description: 'CLO Personal only. Proves or disproves one exact X-to-Y-to-Z traversal inside one mandatory matter. Inputs and returned provenance are opaque hashes, never names, source text, predicate text, or document identifiers. Does not infer a direct X-to-Z legal relationship.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape,
    outputShape: { mode: z.string(), matter_id: z.string().optional(), complete_scan: z.boolean().optional(), complete_chain: z.boolean(), direct_x_z_present: z.boolean().optional(), x_y: z.array(z.unknown()), y_z: z.array(z.unknown()), x_z: z.array(z.unknown()), error: z.string().optional() },
    redactInputForLog: (input) => ({ matter_id: input.matter_id, entity_hashes_redacted: true }),
    handler: (input, ctx) => handlePersonalGraphQuery(input, ctx),
  }, callerHash);
}

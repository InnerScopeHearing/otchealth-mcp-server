import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { querySyntheticRelationships, type RelationshipServiceDeps } from '../../relationships/service.js';
import { PredicateSchema, utcMillis } from '../../relationships/schema.js';
import { registerTool, type CallerHashProvider, type ToolContext } from '../registry.js';

export interface RelationshipPilotQueryInput {
  entity_id: string; hops?: 1 | 2; predicates?: Array<'depends_on' | 'hosted_on' | 'replaced_by'>;
  as_of_valid?: string; as_of_transaction?: string; include_candidates?: boolean;
}
export async function handleRelationshipPilotQuery(input: RelationshipPilotQueryInput, ctx: ToolContext, deps?: RelationshipServiceDeps) {
  const now = deps?.now() ?? new Date();
  const asOfValid = input.as_of_valid ?? now.toISOString();
  const asOfTransaction = input.as_of_transaction ?? now.toISOString();
  utcMillis(asOfValid, 'as_of_valid');
  utcMillis(asOfTransaction, 'as_of_transaction');
  const result = await querySyntheticRelationships({
    entityId: input.entity_id, hops: input.hops ?? 2, predicates: input.predicates,
    asOfValid, asOfTransaction, includeCandidates: input.include_candidates ?? false,
  }, ctx, deps);
  return { data: result, summary: `Returned ${result.edges.length} visible synthetic relationship edges from projection ${result.generation_id}.` };
}
const UtcInput = z.string().refine((value) => { try { utcMillis(value, 'timestamp'); return true; } catch { return false; } }, 'must be a real canonical UTC timestamp ending in Z');
export function registerRelationshipPilotQuery(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'relationship_pilot_query',
    category: 'read',
    annotations: {
      title: 'Query synthetic relationships',
      description: 'CTO-only disabled-by-default pilot. Query one or two governed hops from the exact immutable S3 projection using valid time and transaction time. Returns structured synthetic paths and evidence hashes only.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape: {
      entity_id: z.string().regex(/^synthetic_[a-z0-9_]{1,80}$/),
      hops: z.union([z.literal(1), z.literal(2)]).optional().default(2),
      predicates: z.array(PredicateSchema).max(3).optional(),
      as_of_valid: UtcInput.optional(),
      as_of_transaction: UtcInput.optional(),
      include_candidates: z.boolean().optional().default(false),
    },
    outputShape: { generation_id: z.string(), event_set_sha256: z.string(), nodes: z.array(z.unknown()), edges: z.array(z.unknown()) },
    handler: handleRelationshipPilotQuery,
  }, callerHash);
}

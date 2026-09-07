import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { rebuildSyntheticRelationships, type RelationshipServiceDeps } from '../../relationships/service.js';
import { registerTool, type CallerHashProvider, type ToolContext } from '../registry.js';

export async function handleRelationshipPilotRebuild(_input: Record<string, never>, ctx: ToolContext, deps?: RelationshipServiceDeps) {
  const result = await rebuildSyntheticRelationships(ctx, deps);
  return { data: result, summary: ctx.dryRun ? 'DRY RUN: validated the synthetic event set without projection writes.' : 'Rebuilt and verified the immutable synthetic relationship projection.', audit: ctx.dryRun ? undefined : { after: result } };
}
export function registerRelationshipPilotRebuild(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'relationship_pilot_rebuild',
    category: 'write_simple',
    annotations: {
      title: 'Rebuild synthetic relationship projection',
      description: 'CTO-only disabled-by-default pilot. Rebuild the bounded immutable S3 adjacency projection from the complete synthetic event set and publish its manifest last. Pass dry_run=false to write.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape: {},
    outputShape: { rebuilt: z.boolean(), generation_id: z.string().optional(), event_set_sha256: z.string().optional(), event_count: z.number().optional(), entity_count: z.number().optional() },
    handler: handleRelationshipPilotRebuild,
  }, callerHash);
}

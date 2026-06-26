import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { addRelationships } from '../../customerio/full-client.js';

export function registerCioObjectAddRelationships(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_object_add_relationships',
    category: 'write_simple',
    annotations: {
      title: 'Add customer-object relationships (Track API)',
      description: 'Associate one or more customers with an object via Track API POST /objects/{object_type_id}/{object_id}/relationships. Enables object-based segmentation and personalization. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      object_type_id: z.number().int().positive().describe('Numeric object type ID.'),
      object_id: z.string().min(1).describe('Your identifier for the object.'),
      relationships: z.array(
        z.object({
          identifiers: z.record(z.string()).describe('Customer identifiers to link (e.g. {"email":"user@example.com"} or {"id":"cust_123"}).'),
        }),
      ).min(1).describe('Array of customer relationship definitions to add.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      object_type_id: z.number(),
      object_id: z.string(),
      relationships_count: z.number(),
      result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, object_type_id: input.object_type_id, object_id: input.object_id, relationships_count: input.relationships.length, result: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would add ${input.relationships.length} relationship(s) to object type=${input.object_type_id} id=${input.object_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await addRelationships({
        object_type_id: input.object_type_id,
        object_id: input.object_id,
        relationships: input.relationships,
        correlationId: ctx.correlationId,
      });
      return {
        data: { executed: true, dry_run: false, object_type_id: input.object_type_id, object_id: input.object_id, relationships_count: input.relationships.length, result },
        audit: { before: null, after: input },
        summary: `Added ${input.relationships.length} relationship(s) to object (type=${input.object_type_id}, id=${input.object_id}).`,
      };
    },
  }, callerHash);
}

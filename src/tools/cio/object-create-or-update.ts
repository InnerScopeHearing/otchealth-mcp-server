import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createOrUpdateObject } from '../../customerio/full-client.js';

export function registerCioObjectCreateOrUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_object_create_or_update',
    category: 'write_simple',
    annotations: {
      title: 'Create or update a Customer.io object (Track API)',
      description: 'Create or update a non-person object (e.g. account, company) in Customer.io via Track API PUT /objects/{object_type_id}/{object_id}. Objects can be related to customers. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      object_type_id: z.number().int().positive().describe('Numeric object type ID (defined in your Customer.io workspace settings).'),
      object_id: z.string().min(1).describe('Your identifier for this object instance.'),
      attributes: z.record(z.unknown()).optional().describe('Key-value attribute map to set on the object.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      object_type_id: z.number(),
      object_id: z.string(),
      result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, object_type_id: input.object_type_id, object_id: input.object_id, result: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create/update object type=${input.object_type_id} id=${input.object_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await createOrUpdateObject({
        object_type_id: input.object_type_id,
        object_id: input.object_id,
        attributes: input.attributes,
        correlationId: ctx.correlationId,
      });
      return {
        data: { executed: true, dry_run: false, object_type_id: input.object_type_id, object_id: input.object_id, result },
        audit: { before: null, after: input },
        summary: `Object (type=${input.object_type_id}, id=${input.object_id}) created/updated.`,
      };
    },
  }, callerHash);
}

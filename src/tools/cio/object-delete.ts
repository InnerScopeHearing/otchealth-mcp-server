import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteObject } from '../../customerio/full-client.js';

export function registerCioObjectDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_object_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a Customer.io object (Track API)',
      description: 'Permanently delete a non-person object via Track API DELETE /objects/{object_type_id}/{object_id}. Irreversible — removes the object and all its relationships. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      object_type_id: z.number().int().positive().describe('Numeric object type ID.'),
      object_id: z.string().min(1).describe('Your identifier for the object to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      object_type_id: z.number(),
      object_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, object_type_id: input.object_type_id, object_id: input.object_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete object type=${input.object_type_id} id=${input.object_id}. Pass dry_run=false to confirm.`,
        };
      }
      await deleteObject({ object_type_id: input.object_type_id, object_id: input.object_id, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, object_type_id: input.object_type_id, object_id: input.object_id },
        audit: { before: { object_type_id: input.object_type_id, object_id: input.object_id }, after: null },
        summary: `Object (type=${input.object_type_id}, id=${input.object_id}) deleted.`,
      };
    },
  }, callerHash);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteSegment } from '../../customerio/full-client.js';

export function registerCioSegmentDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_segment_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a Customer.io segment',
      description: 'Permanently delete a segment from the Customer.io workspace via App API DELETE /segments/{id}. Irreversible — the segment definition and membership are lost. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      segment_id: z.number().int().positive().describe('Numeric ID of the segment to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      segment_id: z.number(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, segment_id: input.segment_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete segment ${input.segment_id}. This is irreversible. Pass dry_run=false to confirm.`,
        };
      }
      await deleteSegment({ segment_id: input.segment_id, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, segment_id: input.segment_id },
        audit: { before: { segment_id: input.segment_id }, after: null },
        summary: `Segment ${input.segment_id} deleted.`,
      };
    },
  }, callerHash);
}

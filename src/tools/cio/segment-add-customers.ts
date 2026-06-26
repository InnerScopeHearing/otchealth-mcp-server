import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { addCustomersToSegment } from '../../customerio/full-client.js';

export function registerCioSegmentAddCustomers(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_segment_add_customers',
    category: 'write_simple',
    annotations: {
      title: 'Add customers to a Customer.io segment',
      description: 'Add one or more customers to a manual segment via App API POST /segments/{id}/membership. Accepts an array of customer IDs. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      segment_id: z.number().int().positive().describe('Numeric ID of the manual segment to add customers to.'),
      ids: z.array(z.string().min(1)).min(1).max(1000).describe('Array of customer IDs (up to 1000 per call) to add to the segment.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      segment_id: z.number(),
      ids_count: z.number(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, segment_id: input.segment_id, ids_count: input.ids.length },
          audit: { before: null, after: input },
          summary: `DRY RUN: would add ${input.ids.length} customer(s) to segment ${input.segment_id}. Pass dry_run=false to apply.`,
        };
      }
      await addCustomersToSegment({ segment_id: input.segment_id, ids: input.ids, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, segment_id: input.segment_id, ids_count: input.ids.length },
        audit: { before: null, after: input },
        summary: `Added ${input.ids.length} customer(s) to segment ${input.segment_id}.`,
      };
    },
  }, callerHash);
}

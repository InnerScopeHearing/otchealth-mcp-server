import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createSegment } from '../../customerio/full-client.js';

export function registerCioSegmentCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_segment_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a Customer.io segment',
      description: 'Create a new segment in the Customer.io workspace via App API POST /segments. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().min(1).describe('Display name for the segment.'),
      description: z.string().optional().describe('Optional description of the segment purpose.'),
      type: z.enum(['manual', 'behavioral', 'data']).optional().describe('Segment type. "manual" means membership is managed via API. Defaults to "manual".'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      segment: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, segment: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create segment "${input.name}" (type: ${input.type ?? 'manual'}). Pass dry_run=false to apply.`,
        };
      }
      const segment = await createSegment({ ...input, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, segment },
        audit: { before: null, after: input },
        summary: `Segment "${input.name}" created.`,
      };
    },
  }, callerHash);
}

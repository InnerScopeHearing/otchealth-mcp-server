import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createDeliveriesExport } from '../../customerio/full-client.js';

export function registerCioExportCreateDeliveries(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_export_create_deliveries',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create a Customer.io deliveries export',
      description: 'Initiate a message delivery export via App API POST /exports/deliveries. Exports a CSV of delivery records for a campaign or time range. Poll cio_export_get for status. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      campaign_id: z.number().int().positive().optional().describe('Restrict export to deliveries from this campaign ID.'),
      newsletter_id: z.number().int().positive().optional().describe('Restrict export to deliveries from this newsletter/broadcast ID.'),
      type: z.string().optional().describe('Message type filter (e.g. "email", "push", "sms").'),
      start: z.number().int().optional().describe('Start Unix timestamp — only include deliveries after this time.'),
      end: z.number().int().optional().describe('End Unix timestamp — only include deliveries before this time.'),
      fields: z.array(z.string()).optional().describe('Specific fields to include in the export CSV.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      export_job: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, export_job: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would initiate a deliveries export (campaign_id=${input.campaign_id ?? 'all'}). Pass dry_run=false to start.`,
        };
      }
      const export_job = await createDeliveriesExport({
        campaign_id: input.campaign_id,
        newsletter_id: input.newsletter_id,
        type: input.type,
        start: input.start,
        end: input.end,
        fields: input.fields,
        correlationId: ctx.correlationId,
      });
      return {
        data: { executed: true, dry_run: false, export_job },
        audit: { before: null, after: input },
        summary: 'Deliveries export job initiated. Use cio_export_get to check status.',
      };
    },
  }, callerHash);
}

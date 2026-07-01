import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCustomersExport } from '../../customerio/full-client.js';

export function registerCioExportCreateCustomers(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_export_create_customers',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create a Customer.io customers export',
      description: 'Initiate a customers data export via App API POST /exports/customers. Exports a CSV of customer profiles matching a segment or filter. The export runs async — poll cio_export_get for status, then cio_export_download for the file URL. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      segment_id: z.number().int().positive().optional().describe('Restrict export to customers in this segment ID.'),
      filter: z.record(z.unknown()).optional().describe('Customer.io filter expression to restrict the export. Alternative to segment_id.'),
      fields: z.array(z.string()).optional().describe('Specific attribute fields to include in the export CSV. Omit for all fields.'),
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
          summary: `DRY RUN: would initiate a customers export (segment_id=${input.segment_id ?? 'all'}). Pass dry_run=false to start.`,
        };
      }
      const export_job = await createCustomersExport({
        segment_id: input.segment_id,
        filter: input.filter,
        fields: input.fields,
        correlationId: ctx.correlationId,
      });
      return {
        data: { executed: true, dry_run: false, export_job },
        audit: { before: null, after: input },
        summary: 'Customers export job initiated. Use cio_export_get to check status.',
      };
    },
  }, callerHash);
}

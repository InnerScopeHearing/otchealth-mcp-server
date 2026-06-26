import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getExport } from '../../customerio/full-client.js';

export function registerCioExportGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_export_get',
    category: 'read',
    annotations: {
      title: 'Get Customer.io export job status',
      description: 'Fetch the current status of a data export job via App API GET /exports/{id}. Returns status (pending/ready/failed), record count, and completion timestamp. When status is "ready", use cio_export_download to get the file URL.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      export_id: z.number().int().positive().describe('Numeric ID of the export job returned by cio_export_create_customers or cio_export_create_deliveries.'),
    },
    outputShape: {
      export_job: z.unknown(),
    },
    handler: async (input, ctx) => {
      const export_job = await getExport({ export_id: input.export_id, correlationId: ctx.correlationId });
      return { data: { export_job } };
    },
  }, callerHash);
}

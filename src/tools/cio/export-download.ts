import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { downloadExport } from '../../customerio/full-client.js';

export function registerCioExportDownload(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_export_download',
    category: 'read',
    annotations: {
      title: 'Get download URL for a Customer.io export',
      description: 'Fetch the pre-signed download URL for a completed export job via App API GET /exports/{id}/download. The URL is time-limited (typically 1 hour). Check job status with cio_export_get first.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      export_id: z.number().int().positive().describe('Numeric ID of the completed export job.'),
    },
    outputShape: {
      download_info: z.unknown(),
    },
    handler: async (input, ctx) => {
      const download_info = await downloadExport({ export_id: input.export_id, correlationId: ctx.correlationId });
      return { data: { download_info } };
    },
  }, callerHash);
}

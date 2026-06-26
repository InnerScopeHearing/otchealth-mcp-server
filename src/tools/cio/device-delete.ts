import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteDevice } from '../../customerio/full-client.js';

export function registerCioDeviceDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_device_delete',
    category: 'write_simple',
    annotations: {
      title: 'Delete a device from a Customer.io customer (Track API)',
      description: 'Remove a mobile device registration from a customer via Track API DELETE /customers/{id}/devices/{device_id}. The customer will no longer receive push notifications to this device. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      customer_id: z.string().min(1).describe('Customer identifier (email, id, or cio_id).'),
      device_id: z.string().min(1).describe('Device token to remove.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      customer_id: z.string(),
      device_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, customer_id: input.customer_id, device_id: input.device_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would remove device "${input.device_id}" from customer "${input.customer_id}". Pass dry_run=false to apply.`,
        };
      }
      await deleteDevice({ customer_id: input.customer_id, device_id: input.device_id, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, customer_id: input.customer_id, device_id: input.device_id },
        audit: { before: { customer_id: input.customer_id, device_id: input.device_id }, after: null },
        summary: `Device "${input.device_id}" removed from customer "${input.customer_id}".`,
      };
    },
  }, callerHash);
}

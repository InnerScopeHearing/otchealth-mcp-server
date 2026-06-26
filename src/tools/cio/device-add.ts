import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { addDevice } from '../../customerio/full-client.js';

export function registerCioDeviceAdd(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_device_add',
    category: 'write_simple',
    annotations: {
      title: 'Add/update a device for a Customer.io customer (Track API)',
      description: 'Register or update a mobile device (iOS/Android) for push notifications via Track API PUT /customers/{id}/devices. Enables push notification delivery for this customer. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      customer_id: z.string().min(1).describe('Customer identifier (email, id, or cio_id) to attach the device to.'),
      device_id: z.string().min(1).describe('Unique device token from APNS (iOS) or FCM (Android).'),
      platform: z.enum(['ios', 'android']).describe('Mobile platform for this device.'),
      attributes: z.record(z.unknown()).optional().describe('Optional additional device attributes (e.g. device model, OS version).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      customer_id: z.string(),
      device_id: z.string(),
      result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, customer_id: input.customer_id, device_id: input.device_id, result: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would register ${input.platform} device "${input.device_id}" for customer "${input.customer_id}". Pass dry_run=false to apply.`,
        };
      }
      const result = await addDevice({
        customer_id: input.customer_id,
        device_id: input.device_id,
        platform: input.platform,
        attributes: input.attributes,
        correlationId: ctx.correlationId,
      });
      return {
        data: { executed: true, dry_run: false, customer_id: input.customer_id, device_id: input.device_id, result },
        audit: { before: null, after: input },
        summary: `${input.platform} device registered for customer "${input.customer_id}".`,
      };
    },
  }, callerHash);
}

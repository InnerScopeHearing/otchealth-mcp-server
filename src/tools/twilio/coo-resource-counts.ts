import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listMessagingServices, listIncomingPhoneNumbers } from '../../twilio/full-client.js';
import { currentCallerAgent } from '../../server/request-context.js';
import { readCooTwilioResourceCounts, twilioPageSizeSchema } from './coo-resource-counts-projection.js';

export function registerTwilioCooResourceCounts(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_coo_resource_counts',
    category: 'read',
    annotations: {
      title: 'Read bounded Twilio resource counts',
      description: 'Returns counts from bounded Twilio Messaging Service and owned-number pages. No resource details are returned.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      page_size: twilioPageSizeSchema.optional().describe('Maximum records requested from each list, default 20.'),
    },
    outputShape: {
      requested_page_size: z.number().int().min(1).max(100),
      messaging_services_returned: z.number().int().nonnegative(),
      incoming_numbers_returned: z.number().int().nonnegative(),
    },
    handler: async (input) => {
      const pageSize = input.page_size ?? 20;
      const data = await readCooTwilioResourceCounts({
        caller: currentCallerAgent(),
        pageSize,
        listMessagingServices,
        listIncomingNumbers: (size) => listIncomingPhoneNumbers({ page_size: size }),
      });
      return {
        data,
        summary: `Twilio returned ${data.messaging_services_returned} messaging-service and ${data.incoming_numbers_returned} incoming-number record(s) in the requested pages.`,
      };
    },
  }, callerHash);
}

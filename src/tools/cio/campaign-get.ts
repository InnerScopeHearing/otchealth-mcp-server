import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCampaign } from '../../customerio/full-client.js';

export function registerCioCampaignGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_campaign_get',
    category: 'read',
    annotations: {
      title: 'Get a Customer.io campaign',
      description: 'Fetch full metadata for a single campaign via App API GET /campaigns/{id}. Returns name, type, state, triggers, actions, and schedule details.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      campaign_id: z.number().int().positive().describe('Numeric ID of the Customer.io campaign.'),
    },
    outputShape: {
      campaign: z.unknown(),
    },
    handler: async (input, ctx) => {
      const campaign = await getCampaign({ campaign_id: input.campaign_id, correlationId: ctx.correlationId });
      return { data: { campaign } };
    },
  }, callerHash);
}

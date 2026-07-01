import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCampaignActions } from '../../customerio/full-client.js';

export function registerCioCampaignGetActions(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_campaign_get_actions',
    category: 'read',
    annotations: {
      title: 'Get Customer.io campaign actions',
      description: 'Fetch all actions (message steps) for a campaign via App API GET /campaigns/{id}/actions. Returns the list of email/push/SMS/webhook actions attached to the campaign.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      campaign_id: z.number().int().positive().describe('Numeric ID of the Customer.io campaign.'),
    },
    outputShape: {
      actions: z.unknown(),
    },
    handler: async (input, ctx) => {
      const actions = await getCampaignActions({ campaign_id: input.campaign_id, correlationId: ctx.correlationId });
      return { data: { actions } };
    },
  }, callerHash);
}

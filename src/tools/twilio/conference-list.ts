import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listConferences } from '../../twilio/full-client.js';

export function registerTwilioConferenceList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_conference_list',
    category: 'read',
    annotations: {
      title: 'List Twilio conferences',
      description: 'Lists conference resources on the account via GET /Accounts/{SID}/Conferences.json with optional status/name filters. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      status: z.string().optional().describe('Filter by status: init, in-progress, or completed.'),
      friendly_name: z.string().optional().describe('Filter by conference friendly name.'),
      page_size: z.number().int().min(1).max(100).optional().describe('Number of results (default 20, max 100).'),
    },
    outputShape: {
      conferences: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const conferences = await listConferences(input);
      return {
        data: { conferences, count: conferences.length },
        summary: `Found ${conferences.length} conference(s).`,
      };
    },
  }, callerHash);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcGetCompany } from '../../intercom/full-client.js';

export function registerIntercomCompanyGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_company_get',
    category: 'read',
    annotations: {
      title: 'Get an Intercom company by ID',
      description: 'Retrieve full details of a single Intercom company by its Intercom company ID via GET /companies/:id.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      company_id: z.string().describe('Intercom company ID.'),
    },
    outputShape: {
      company: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const company = await fcGetCompany(input.company_id);
      return {
        data: { company },
        summary: `Company ${input.company_id} retrieved.`,
      };
    },
  }, callerHash);
}

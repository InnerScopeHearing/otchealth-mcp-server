import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListCompanies } from '../../intercom/full-client.js';

export function registerIntercomCompanyList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_company_list',
    category: 'read',
    annotations: {
      title: 'List Intercom companies',
      description: 'Paginated list of all companies in the Intercom workspace via GET /companies.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      per_page: z.number().int().min(1).max(150).optional().describe('Companies per page (max 150).'),
      page: z.number().int().min(1).optional().describe('Page number.'),
      order: z.enum(['asc', 'desc']).optional().describe('Sort order.'),
      sort: z.string().optional().describe('Field to sort by (e.g. "created_at", "name").'),
    },
    outputShape: {
      companies: z.array(z.unknown()),
      count: z.number(),
      total_count: z.number().nullable(),
    },
    handler: async (input, _ctx) => {
      const resp = await fcListCompanies({
        per_page: input.per_page,
        page: input.page,
        order: input.order,
        sort: input.sort,
      });
      const companies = resp.data ?? resp.companies ?? [];
      return {
        data: {
          companies,
          count: companies.length,
          total_count: resp.total_count ?? null,
        },
        summary: `Found ${companies.length} company/companies.`,
      };
    },
  }, callerHash);
}

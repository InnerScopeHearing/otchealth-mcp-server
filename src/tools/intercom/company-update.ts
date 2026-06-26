import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcUpdateCompany } from '../../intercom/full-client.js';

export function registerIntercomCompanyUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_company_update',
    category: 'write_simple',
    annotations: {
      title: 'Update an Intercom company',
      description: 'Update fields on an existing Intercom company via PUT /companies/:id. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      company_id_param: z.string().describe('Intercom company ID (the internal Intercom id, not your external company_id).'),
      name: z.string().optional().describe('New company name.'),
      plan: z.string().optional().describe('New plan name.'),
      monthly_spend: z.number().optional().describe('New monthly spend.'),
      size: z.number().int().optional().describe('New company size.'),
      website: z.string().url().optional().describe('New website URL.'),
      industry: z.string().optional().describe('New industry.'),
      custom_attributes: z.record(z.unknown()).optional().describe('Custom attributes to update.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      company_id_param: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, company_id_param: input.company_id_param },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update company ${input.company_id_param}. Pass dry_run=false to apply.`,
        };
      }
      await fcUpdateCompany(input);
      return {
        data: { executed: true, dry_run: false, company_id_param: input.company_id_param },
        audit: { before: null, after: input },
        summary: `Company ${input.company_id_param} updated.`,
      };
    },
  }, callerHash);
}

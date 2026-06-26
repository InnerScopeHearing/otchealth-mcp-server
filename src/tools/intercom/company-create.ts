import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcCreateCompany } from '../../intercom/full-client.js';

export function registerIntercomCompanyCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_company_create',
    category: 'write_simple',
    annotations: {
      title: 'Create an Intercom company',
      description: 'Create or update a company in Intercom via POST /companies. If company_id already exists, the company is updated (upsert). Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      company_id: z.string().optional().describe('Your external company identifier (for idempotent upsert).'),
      name: z.string().optional().describe('Company name.'),
      plan: z.string().optional().describe('Company plan name.'),
      monthly_spend: z.number().optional().describe('Monthly spend amount.'),
      size: z.number().int().optional().describe('Company size (number of employees).'),
      website: z.string().url().optional().describe('Company website URL.'),
      industry: z.string().optional().describe('Company industry.'),
      custom_attributes: z.record(z.unknown()).optional().describe('Custom attribute key-value pairs.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      intercom_id: z.string().nullable(),
      company_id: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, intercom_id: null, company_id: input.company_id ?? null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create company "${input.name ?? input.company_id ?? '(unnamed)'}". Pass dry_run=false to apply.`,
        };
      }
      const resp = await fcCreateCompany(input);
      return {
        data: { executed: true, dry_run: false, intercom_id: resp.id ?? null, company_id: resp.company_id ?? input.company_id ?? null },
        audit: { before: null, after: input },
        summary: `Company created/updated (Intercom id: ${resp.id ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcTagCompany } from '../../intercom/full-client.js';

export function registerIntercomTagCompany(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_tag_company',
    category: 'write_simple',
    annotations: {
      title: 'Tag an Intercom company',
      description: 'Apply a tag to a company via POST /tags with company id in the companies array. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      company_id: z.string().describe('Intercom company ID to tag.'),
      tag_id: z.string().describe('Intercom tag ID to apply.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      company_id: z.string(),
      tag_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, company_id: input.company_id, tag_id: input.tag_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would tag company ${input.company_id} with tag ${input.tag_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcTagCompany({ company_id: input.company_id, tag_id: input.tag_id });
      return {
        data: { executed: true, dry_run: false, company_id: input.company_id, tag_id: input.tag_id },
        audit: { before: null, after: input },
        summary: `Company ${input.company_id} tagged with tag ${input.tag_id}.`,
      };
    },
  }, callerHash);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcUntagCompany } from '../../intercom/full-client.js';

export function registerIntercomUntagCompany(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_untag_company',
    category: 'write_simple',
    annotations: {
      title: 'Remove a tag from an Intercom company',
      description: 'Remove a tag from a company via POST /tags with company id and untag:true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      company_id: z.string().describe('Intercom company ID.'),
      tag_id: z.string().describe('Intercom tag ID to remove.'),
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
          summary: `DRY RUN: would remove tag ${input.tag_id} from company ${input.company_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcUntagCompany({ company_id: input.company_id, tag_id: input.tag_id });
      return {
        data: { executed: true, dry_run: false, company_id: input.company_id, tag_id: input.tag_id },
        audit: { before: null, after: input },
        summary: `Tag ${input.tag_id} removed from company ${input.company_id}.`,
      };
    },
  }, callerHash);
}

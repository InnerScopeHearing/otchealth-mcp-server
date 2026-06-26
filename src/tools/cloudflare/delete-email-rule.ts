import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteEmailRoutingRule } from '../../cloudflare/write-client.js';

export function registerCloudflareDeleteEmailRule(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_delete_email_rule',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete email routing rule',
      description:
        'Permanently delete an email routing rule. Mail that matched this rule will no longer be forwarded. ' +
        'Use cloudflare_list_email_rules first to confirm the rule ID. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      rule_id: z.string().min(1).describe('The email routing rule ID to delete (from cloudflare_list_email_rules). Confirm the rule before deleting.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      rule_id: z.string(),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            rule_id: input.rule_id,
            upstream_result: null,
          },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently DELETE email routing rule ${input.rule_id}. Pass dry_run=false to apply.`,
        };
      }

      const upstream = await deleteEmailRoutingRule(input.rule_id);

      return {
        data: {
          executed: true,
          dry_run: false,
          rule_id: input.rule_id,
          upstream_result: upstream?.result ?? upstream,
        },
        audit: { before: null, after: { rule_id: input.rule_id } },
        summary: `Deleted email routing rule ${input.rule_id}.`,
      };
    },
  }, callerHash);
}

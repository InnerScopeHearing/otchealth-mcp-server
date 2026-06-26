import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateEmailRoutingRule } from '../../cloudflare/write-client.js';

export function registerCloudflareUpdateEmailRule(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_update_email_rule',
    category: 'write_orchestrated',
    annotations: {
      title: 'Update email routing rule',
      description:
        'Replace an email routing rule (PUT). Supply the rule_id plus any fields you want to change. ' +
        'The Cloudflare Email Routing API requires a full PUT body; this tool merges your supplied fields with defaults. ' +
        'Changing match_address or forward_to will reroute live mail. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      rule_id: z.string().min(1).describe('The email routing rule ID to update (from cloudflare_list_email_rules).'),
      name: z.string().optional().describe('New rule name — omit to leave unchanged.'),
      enabled: z.boolean().optional().describe('Enable or disable the rule — omit to default to true.'),
      match_address: z.string().email().optional().describe('New address to match (e.g. coo@otchealth.app) — omit to leave unchanged.'),
      forward_to: z.string().email().optional().describe('New forward-to destination (e.g. bot-xxx@bot.hyperagent.email) — omit to leave unchanged.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      rule_id: z.string(),
      updated_fields: z.array(z.string()),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      const updatedFields = (['name', 'enabled', 'match_address', 'forward_to'] as const)
        .filter((k) => input[k] !== undefined);

      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            rule_id: input.rule_id,
            updated_fields: updatedFields,
            upstream_result: null,
          },
          audit: { before: null, after: input },
          summary: `DRY RUN: would PUT email routing rule ${input.rule_id} — fields: ${updatedFields.join(', ') || '(none)'}. Pass dry_run=false to apply.`,
        };
      }

      const upstream = await updateEmailRoutingRule({
        ruleId: input.rule_id,
        name: input.name,
        enabled: input.enabled,
        matchAddress: input.match_address,
        forwardTo: input.forward_to,
      });

      return {
        data: {
          executed: true,
          dry_run: false,
          rule_id: input.rule_id,
          updated_fields: updatedFields,
          upstream_result: upstream?.result ?? upstream,
        },
        audit: { before: null, after: input },
        summary: `Updated email routing rule ${input.rule_id} — fields changed: ${updatedFields.join(', ')}.`,
      };
    },
  }, callerHash);
}

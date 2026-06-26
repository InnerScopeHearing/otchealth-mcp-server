import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateAlertRule } from '../../sentry/full-client.js';

export function registerSentryAlertRuleUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_alert_rule_update',
    category: 'write_orchestrated',
    annotations: {
      title: 'Update a Sentry alert rule',
      description: 'Update an existing Sentry issue alert rule. MedReview PHI projects are blocked. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
      rule_id: z.string().min(1).describe('Alert rule numeric ID.'),
      updates: z.record(z.unknown()).describe('Partial rule object — only provide fields to change (name, conditions, actions, filters, actionMatch, frequency, etc.).'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), upstream_response: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, upstream_response: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update alert rule ${input.rule_id} in project "${input.project_slug}". Pass dry_run=false to apply.`,
        };
      }
      const result = await updateAlertRule(input.project_slug, input.rule_id, input.updates);
      return {
        data: { executed: true, dry_run: false, upstream_response: result },
        audit: { before: null, after: input },
        summary: `Alert rule ${input.rule_id} updated in project "${input.project_slug}".`,
      };
    },
  }, callerHash);
}

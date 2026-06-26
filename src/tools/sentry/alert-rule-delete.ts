import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteAlertRule } from '../../sentry/full-client.js';

export function registerSentryAlertRuleDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_alert_rule_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a Sentry alert rule',
      description: 'Permanently delete an issue alert rule from a Sentry project. Irreversible. MedReview PHI projects are blocked. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
      rule_id: z.string().min(1).describe('Alert rule numeric ID to delete.'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), rule_id: z.string() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, rule_id: input.rule_id },
          audit: { before: null, after: { project_slug: input.project_slug, rule_id: input.rule_id } },
          summary: `DRY RUN: would delete alert rule ${input.rule_id} from project "${input.project_slug}". Pass dry_run=false to apply.`,
        };
      }
      await deleteAlertRule(input.project_slug, input.rule_id);
      return {
        data: { executed: true, dry_run: false, rule_id: input.rule_id },
        audit: { before: { project_slug: input.project_slug, rule_id: input.rule_id }, after: null },
        summary: `Alert rule ${input.rule_id} deleted from project "${input.project_slug}".`,
      };
    },
  }, callerHash);
}

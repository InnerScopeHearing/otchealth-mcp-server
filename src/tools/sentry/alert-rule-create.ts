import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createAlertRule } from '../../sentry/full-client.js';

export function registerSentryAlertRuleCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_alert_rule_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create a Sentry alert rule',
      description: 'Create an issue alert rule in a Sentry project. MedReview PHI projects are blocked. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
      name: z.string().min(1).describe('Alert rule name.'),
      conditions: z.array(z.record(z.unknown())).describe('Array of condition objects (see Sentry docs, e.g. [{id:"sentry.rules.conditions.first_seen_event.FirstSeenEventCondition"}]).'),
      actions: z.array(z.record(z.unknown())).describe('Array of action objects (e.g. notify team, send email).'),
      filters: z.array(z.record(z.unknown())).optional().describe('Optional filter objects.'),
      action_match: z.enum(['all', 'any', 'none']).optional().describe('How to combine conditions (default "any").'),
      filter_match: z.enum(['all', 'any', 'none']).optional().describe('How to combine filters (default "all").'),
      frequency: z.number().int().optional().describe('Minimum minutes between alerts (default 30).'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), rule: z.unknown().nullable() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, rule: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create alert rule "${input.name}" in project "${input.project_slug}". Pass dry_run=false to apply.`,
        };
      }
      const rule = await createAlertRule(input.project_slug, {
        name: input.name,
        conditions: input.conditions,
        actions: input.actions,
        filters: input.filters,
        actionMatch: input.action_match,
        filterMatch: input.filter_match,
        frequency: input.frequency,
      });
      return {
        data: { executed: true, dry_run: false, rule },
        audit: { before: null, after: input },
        summary: `Alert rule "${input.name}" created in project "${input.project_slug}".`,
      };
    },
  }, callerHash);
}

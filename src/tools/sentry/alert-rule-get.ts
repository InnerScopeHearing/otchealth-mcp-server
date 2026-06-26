import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getAlertRule } from '../../sentry/full-client.js';

export function registerSentryAlertRuleGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_alert_rule_get',
    category: 'read',
    annotations: {
      title: 'Get a Sentry alert rule',
      description: 'Retrieve full details for a single Sentry alert rule. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
      rule_id: z.string().min(1).describe('Alert rule numeric ID.'),
    },
    outputShape: { rule: z.unknown() },
    handler: async (input) => {
      const rule = await getAlertRule(input.project_slug, input.rule_id);
      return { data: { rule }, summary: `Alert rule ${input.rule_id} in project "${input.project_slug}".` };
    },
  }, callerHash);
}

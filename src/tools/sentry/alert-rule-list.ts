import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listAlertRules } from '../../sentry/full-client.js';

export function registerSentryAlertRuleList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_alert_rule_list',
    category: 'read',
    annotations: {
      title: 'List Sentry alert rules',
      description: 'List all issue alert rules for a Sentry project. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
    },
    outputShape: { rules: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const rules = await listAlertRules(input.project_slug);
      return { data: { rules, count: rules.length }, summary: `${rules.length} alert rule(s) in project "${input.project_slug}".` };
    },
  }, callerHash);
}

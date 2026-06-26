import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateProject } from '../../posthog/full-client.js';

export function registerPostHogProjectUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_project_update',
    category: 'write_orchestrated',
    annotations: {
      title: 'Update PostHog project settings',
      description: 'Update project-level settings (PATCH /api/projects/{id}/). Affects all data collection for the project — high risk. MedReview PHI project 468398 is blocked. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      name: z.string().optional().describe('Updated project name.'),
      timezone: z.string().optional().describe('IANA timezone name (e.g. "America/New_York").'),
      anonymize_ips: z.boolean().optional().describe('Whether to anonymize IP addresses.'),
      slack_incoming_webhook: z.string().optional().describe('Slack webhook URL for PostHog notifications.'),
      completed_snippet_onboarding: z.boolean().optional().describe('Mark snippet onboarding as complete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, upstream_response: null },
          audit: { before: null, after: { name: input.name, timezone: input.timezone, anonymize_ips: input.anonymize_ips } },
          summary: `DRY RUN: would update project ${input.project_id} settings. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateProject({
        project_id: input.project_id,
        name: input.name,
        timezone: input.timezone,
        anonymize_ips: input.anonymize_ips,
        slack_incoming_webhook: input.slack_incoming_webhook,
        completed_snippet_onboarding: input.completed_snippet_onboarding,
      });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, upstream_response: upstream },
        audit: { before: null, after: { name: input.name, timezone: input.timezone } },
        summary: `PostHog project ${input.project_id} settings updated.`,
      };
    },
  }, callerHash);
}

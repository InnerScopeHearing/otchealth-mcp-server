import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getIssue } from '../../sentry/full-client.js';

export function registerSentryIssueGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_issue_get',
    category: 'read',
    annotations: {
      title: 'Get Sentry issue',
      description: 'Retrieve full details for a single Sentry issue by ID. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      issue_id: z.string().min(1).describe('Sentry issue numeric ID (e.g. "123456789").'),
      project_slug: z.string().min(1).describe('Project slug the issue belongs to (PHI guard). MedReview blocked.'),
    },
    outputShape: { issue: z.unknown() },
    handler: async (input) => {
      const issue = await getIssue(input.issue_id, input.project_slug);
      return { data: { issue }, summary: `Issue ${input.issue_id}: ${issue?.title ?? '(no title)'}` };
    },
  }, callerHash);
}

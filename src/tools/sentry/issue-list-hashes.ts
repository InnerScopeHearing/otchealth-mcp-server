import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listIssueHashes } from '../../sentry/full-client.js';

export function registerSentryIssueListHashes(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_issue_list_hashes',
    category: 'read',
    annotations: {
      title: 'List hashes for a Sentry issue',
      description: 'Return the deduplication hashes (fingerprints) attached to a Sentry issue. MedReview PHI projects are blocked.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      issue_id: z.string().min(1).describe('Sentry issue ID.'),
      project_slug: z.string().min(1).describe('Project slug (PHI guard). MedReview blocked.'),
    },
    outputShape: { hashes: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const hashes = await listIssueHashes(input.issue_id, input.project_slug);
      return { data: { hashes, count: hashes.length }, summary: `${hashes.length} hash(es) for issue ${input.issue_id}.` };
    },
  }, callerHash);
}

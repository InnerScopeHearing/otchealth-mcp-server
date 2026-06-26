import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { labelUpdate } from '../../github/full-client.js';

export function registerGitHubLabelUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_label_update',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: update label',
      description: 'Update the name, color, or description of an existing label. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      label_name: z.string().describe('Current label name (URL-encoded if it contains spaces).'),
      new_name: z.string().optional().describe('New label name.'),
      color: z.string().optional().describe('New hex color (with or without #).'),
      description: z.string().optional().describe('New description.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      name: z.string().optional(),
      color: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, name: input.label_name },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update label "${input.label_name}" in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await labelUpdate(input.owner, input.repo, input.label_name, { name: input.new_name, color: input.color, description: input.description });
      return {
        data: { executed: true, dry_run: false, name: r.name, color: r.color },
        audit: { before: { name: input.label_name }, after: { name: r.name, color: r.color } },
        summary: `Updated label "${input.label_name}" → "${r.name}" in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}

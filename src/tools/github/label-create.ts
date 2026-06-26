import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { labelCreate } from '../../github/full-client.js';

export function registerGitHubLabelCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_label_create',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: create label',
      description: 'Create a new label in a repository. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      name: z.string().describe('Label name.'),
      color: z.string().describe('Hex color (with or without #), e.g. "e11d48" or "#e11d48".'),
      description: z.string().optional().describe('Short description of the label.'),
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
          data: { executed: false, dry_run: true, name: input.name, color: input.color },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create label "${input.name}" in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await labelCreate(input.owner, input.repo, input.name, input.color, input.description);
      return {
        data: { executed: true, dry_run: false, name: r.name, color: r.color },
        audit: { before: null, after: { name: r.name, color: r.color } },
        summary: `Created label "${r.name}" (#${r.color}) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}

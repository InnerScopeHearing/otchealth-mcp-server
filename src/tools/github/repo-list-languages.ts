import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { repoListLanguages } from '../../github/full-client.js';

export function registerGitHubRepoListLanguages(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_repo_list_languages',
    category: 'read',
    annotations: {
      title: 'GitHub: list languages',
      description: 'Return the byte-count breakdown of programming languages used in a repository. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
    },
    outputShape: {
      languages: z.record(z.number()),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const languages = await repoListLanguages(input.owner, input.repo);
      const total = Object.values(languages).reduce((s, n) => s + n, 0);
      return {
        data: { languages },
        summary: `${Object.keys(languages).length} language(s) in ${input.owner}/${input.repo}; top: ${Object.keys(languages)[0] ?? 'none'} (${total > 0 ? ((Object.values(languages)[0] ?? 0) / total * 100).toFixed(1) : 0}%)`,
      };
    },
  }, callerHash);
}

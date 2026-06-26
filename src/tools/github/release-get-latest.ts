import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { releaseGetLatest } from '../../github/full-client.js';

export function registerGitHubReleaseGetLatest(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_release_get_latest',
    category: 'read',
    annotations: {
      title: 'GitHub: get latest release',
      description: 'Get the latest published (non-draft, non-prerelease) release for a repository. Read-only.',
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
      id: z.number().optional(),
      tag_name: z.string().optional(),
      name: z.string().nullable().optional(),
      published_at: z.string().nullable().optional(),
      url: z.string().optional(),
    },
    handler: async (input) => {
      const r = await releaseGetLatest(input.owner, input.repo);
      return {
        data: { id: r.id, tag_name: r.tag_name, name: r.name, published_at: r.published_at, url: r.html_url },
        summary: `Latest release: ${r.tag_name} published ${r.published_at}`,
      };
    },
  }, callerHash);
}

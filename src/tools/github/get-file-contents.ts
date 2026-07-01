import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getFileContents } from '../../github/api-client.js';

/** github_get_file_contents — read a file's text + sha (read-only; all agents). */
export function registerGitHubGetFileContents(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'github_get_file_contents',
      category: 'read',
      annotations: {
        title: 'GitHub: get file contents',
        description: 'Read a file’s decoded text and blob sha from a repo (optionally at a ref). Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string(),
        repo: z.string(),
        path: z.string().describe('File path within the repo.'),
        ref: z.string().optional().describe('Branch, tag, or commit sha (default: default branch).'),
      },
      outputShape: { path: z.string(), sha: z.string().optional(), text: z.string().optional(), error: z.string().optional() },
      handler: async (input) => {
        const r = await getFileContents(input.owner, input.repo, input.path, input.ref);
        return { data: r, summary: `${input.owner}/${input.repo}:${input.path} (${r.text.length} chars).` };
      },
    },
    callerHash,
  );
}

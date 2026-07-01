import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { releaseGenerateNotes } from '../../github/full-client.js';

export function registerGitHubReleaseGenerateNotes(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_release_generate_notes',
    category: 'read',
    annotations: {
      title: 'GitHub: generate release notes',
      description: 'Auto-generate release notes markdown from merged PRs between two tags. Returns the draft body for review before creating a release. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      tag_name: z.string().describe('The tag name for the upcoming release.'),
      target_commitish: z.string().optional().describe('Branch or commit SHA for the release (default: repo default branch).'),
      previous_tag_name: z.string().optional().describe('Previous tag to compute the range from (default: last release tag).'),
      configuration_file_path: z.string().optional().describe('Path to a .github/release.yml configuration file.'),
    },
    outputShape: {
      name: z.string().optional(),
      body: z.string().optional(),
    },
    handler: async (input) => {
      const r = await releaseGenerateNotes(input.owner, input.repo, input.tag_name, {
        targetCommitish: input.target_commitish,
        previousTagName: input.previous_tag_name,
        configurationFilePath: input.configuration_file_path,
      });
      return {
        data: { name: r.name, body: r.body },
        summary: `Generated release notes for "${input.tag_name}" in ${input.owner}/${input.repo} (${r.body.split('\n').length} lines)`,
      };
    },
  }, callerHash);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createRelease } from '../../github/write-client.js';

/**
 * github_create_release — create a Git tag + GitHub release.
 * write_orchestrated (irreversible public release artifact). CTO-gated; honors dry_run.
 */
export function registerGitHubCreateRelease(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'github_create_release',
      category: 'write_orchestrated',
      annotations: {
        title: 'GitHub: create release',
        description:
          'Create a tagged release in a repository (creates the tag if it does not exist). Optionally auto-generate release notes from merged PRs. Defaults to dry_run. CTO-only.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string().describe('Repository owner or organisation.'),
        repo: z.string().describe('Repository name.'),
        tag_name: z.string().describe('Tag to create or use (e.g. "v1.2.3").'),
        name: z.string().optional().describe('Release display name. Defaults to tag_name.'),
        body: z.string().optional().describe('Release notes body (Markdown). Ignored when generate_release_notes=true.'),
        target_commitish: z
          .string()
          .optional()
          .describe('Branch or commit SHA the tag is created from. Defaults to the repo default branch.'),
        draft: z.boolean().optional().describe('Publish as a draft (not visible to the public). Default: false.'),
        prerelease: z.boolean().optional().describe('Mark as pre-release. Default: false.'),
        generate_release_notes: z
          .boolean()
          .optional()
          .describe('Auto-generate release notes from merged PRs since the last release. Default: false.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        id: z.number().optional(),
        url: z.string().optional(),
        tag_name: z.string().optional(),
        draft: z.boolean().optional(),
        prerelease: z.boolean().optional(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, tag_name: input.tag_name },
            audit: { before: null, after: input },
            summary: `DRY RUN: would create release "${input.tag_name}" in ${input.owner}/${input.repo}. Pass dry_run=false to execute.`,
          };
        }
        const r = await createRelease({
          owner: input.owner,
          repo: input.repo,
          tagName: input.tag_name,
          name: input.name,
          body: input.body,
          targetCommitish: input.target_commitish,
          draft: input.draft,
          prerelease: input.prerelease,
          generateReleaseNotes: input.generate_release_notes,
        });
        return {
          data: {
            executed: true,
            dry_run: false,
            id: r.id,
            url: r.url,
            tag_name: r.tagName,
            draft: r.draft,
            prerelease: r.prerelease,
          },
          audit: { before: null, after: r },
          summary: `Created release "${r.tagName}" in ${input.owner}/${input.repo}: ${r.url}`,
        };
      },
    },
    callerHash,
  );
}

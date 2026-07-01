import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { gitTagCreate, refCreate } from '../../github/full-client.js';

export function registerGitHubGitTagCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_git_tag_create',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: create annotated git tag',
      description: 'Create an annotated git tag object and optionally wire up refs/tags/{tag} to point to it. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      tag: z.string().describe('Tag name, e.g. "v1.2.0".'),
      message: z.string().describe('Annotation message for the tag.'),
      object: z.string().describe('SHA of the commit to tag.'),
      type: z.enum(['commit', 'blob', 'tree']).optional().describe('Object type (default: commit).'),
      tagger_name: z.string().optional().describe('Tagger display name.'),
      tagger_email: z.string().optional().describe('Tagger email.'),
      create_ref: z.boolean().optional().describe('Also create refs/tags/{tag} pointing to the tag object (default true).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      tag_sha: z.string().optional(),
      tag: z.string().optional(),
      ref_created: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, tag: input.tag },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create annotated tag "${input.tag}" on ${input.object?.slice(0, 7)} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await gitTagCreate({
        owner: input.owner,
        repo: input.repo,
        tag: input.tag,
        message: input.message,
        object: input.object,
        type: input.type,
        tagger: input.tagger_name && input.tagger_email ? { name: input.tagger_name, email: input.tagger_email } : undefined,
      });
      let refCreated = false;
      if (input.create_ref !== false) {
        await refCreate(input.owner, input.repo, `refs/tags/${input.tag}`, r.tagSha);
        refCreated = true;
      }
      return {
        data: { executed: true, dry_run: false, tag_sha: r.tagSha, tag: r.tag, ref_created: refCreated },
        audit: { before: null, after: r },
        summary: `Created annotated tag "${r.tag}" (${r.tagSha.slice(0, 7)}) in ${input.owner}/${input.repo}${refCreated ? '; ref created' : ''}`,
      };
    },
  }, callerHash);
}

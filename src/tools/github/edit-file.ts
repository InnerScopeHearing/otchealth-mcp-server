import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { editFile } from '../../github/write-client.js';

/**
 * github_edit_file — surgical, full-content-free in-place edit (old_str -> new_str), so a 2-line change
 * to a 65KB file no longer requires retyping the whole file through a chat channel. old_str must match
 * EXACTLY ONCE (or pass replace_all); an ambiguous/absent match fails loud. CTO-gated + write-gated;
 * dry_run defaults on and returns a diff preview without writing.
 */
export function registerGitHubEditFile(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'github_edit_file',
      category: 'write_simple',
      annotations: {
        title: 'GitHub: surgical in-place file edit (old_str/new_str)',
        description:
          'Edit a file in place by replacing an exact substring (old_str -> new_str) via the App installation token, so a small change to a large file needs no full-file content. old_str MUST match exactly once (zero or multiple matches fail loud; pass replace_all=true for the deliberate multi-occurrence case). Supports expected_sha (optimistic concurrency). CTO-only; dry_run defaults true and returns a diff preview without writing.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string().describe('Repository owner or organisation, e.g. "InnerScopeHearing".'),
        repo: z.string().describe('Repository name.'),
        path: z.string().describe('File path within the repo.'),
        message: z.string().describe('Commit message.'),
        old_str: z.string().min(1).describe('Exact substring to replace (byte-for-byte, including whitespace/indentation). Must match exactly once unless replace_all.'),
        new_str: z.string().describe('Replacement text (inserted literally; $ is not special).'),
        branch: z.string().optional().describe('Branch to edit. Omit for the default branch.'),
        expected_sha: z.string().optional().describe('If set, the edit refuses unless the file blob SHA matches (optimistic concurrency).'),
        replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match. Default false.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        path: z.string(),
        replacements: z.number(),
        sha: z.string(),
        commit: z.string().optional(),
        preview: z.string().optional(),
      },
      handler: async (input, ctx) => {
        const r = await editFile({
          owner: input.owner,
          repo: input.repo,
          path: input.path,
          message: input.message,
          old_str: input.old_str,
          new_str: input.new_str,
          branch: input.branch,
          expected_sha: input.expected_sha,
          replace_all: input.replace_all,
          dry_run: ctx.dryRun,
        });
        if (r.dry_run) {
          return {
            data: r,
            audit: { before: { path: input.path, sha: r.sha }, after: null },
            summary: `DRY RUN: ${input.path} would change (${r.replacements} match(es)). Pass dry_run=false to apply.\n--- preview ---\n${r.preview}`,
          };
        }
        return {
          data: r,
          audit: { before: { path: input.path, sha: r.sha }, after: { commit: r.commit, replacements: r.replacements } },
          summary: `Edited ${input.path} (${r.replacements} replacement(s)) in ${input.owner}/${input.repo} @ commit ${(r.commit || '').slice(0, 12)}.`,
        };
      },
    },
    callerHash,
  );
}

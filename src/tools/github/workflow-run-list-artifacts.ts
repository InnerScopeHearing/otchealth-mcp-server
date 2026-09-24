import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { workflowRunListArtifacts } from '../../github/full-client.js';

function safeArtifactDigest(value: unknown): string | null {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(value)) return null;
  return `sha256:${value.slice('sha256:'.length).toLowerCase()}`;
}

function safeWorkflowRunBinding(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const run = value as Record<string, unknown>;
  if (!Number.isSafeInteger(run.id) || (run.id as number) <= 0 ||
      !Number.isSafeInteger(run.repository_id) || (run.repository_id as number) <= 0 ||
      !Number.isSafeInteger(run.head_repository_id) || (run.head_repository_id as number) <= 0 ||
      typeof run.head_branch !== 'string' || run.head_branch.length === 0 || run.head_branch.length > 255 ||
      typeof run.head_sha !== 'string' || !/^[a-f0-9]{40}$/i.test(run.head_sha)) return null;
  return {
    id: run.id,
    repository_id: run.repository_id,
    head_repository_id: run.head_repository_id,
    head_branch: run.head_branch,
    head_sha: run.head_sha.toLowerCase(),
  };
}

export function registerGitHubWorkflowRunListArtifacts(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_workflow_run_list_artifacts',
    category: 'read',
    annotations: {
      title: 'GitHub: list workflow run artifacts',
      description: 'List artifacts uploaded by a specific workflow run, including the GitHub archive digest and bounded run binding for safe downstream verification. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      run_id: z.number().int().describe('Workflow run numeric ID.'),
    },
    outputShape: {
      artifacts: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const artifacts = await workflowRunListArtifacts(input.owner, input.repo, input.run_id);
      return {
        data: {
          artifacts: artifacts.map((a: any) => ({
            id: a.id,
            name: a.name,
            size_in_bytes: a.size_in_bytes,
            expired: a.expired,
            created_at: a.created_at,
            expires_at: a.expires_at,
            digest: safeArtifactDigest(a.digest),
            workflow_run: safeWorkflowRunBinding(a.workflow_run),
          })),
          count: artifacts.length,
        },
        summary: `${artifacts.length} artifact(s) from run #${input.run_id}`,
      };
    },
  }, callerHash);
}

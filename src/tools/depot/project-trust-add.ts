import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { addTrustPolicy } from '../../depot/full-client.js';

export function registerDepotProjectTrustAdd(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_project_trust_add',
    category: 'write_simple',
    annotations: {
      title: 'Depot: add project trust policy',
      description: 'Add an OIDC trust policy (GitHub Actions, CircleCI, Buildkite, RWX) to a Depot project so CI can authenticate without a static token. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('The Depot project ID.'),
      provider: z.enum(['github', 'circleci', 'buildkite', 'rwx']).describe('OIDC provider.'),
      repository: z.string().optional().describe('GitHub: "owner/repo" (e.g. "InnerScopeHearing/otchealth-ios"). Required for GitHub.'),
      organization: z.string().optional().describe('GitHub: owner name; CircleCI: org UUID; Buildkite: org slug.'),
      project_id2: z.string().optional().describe('CircleCI project UUID or Buildkite pipeline slug.'),
      subject: z.string().optional().describe('RWX Vault subject string.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      trust_policy: z.unknown().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would add ${input.provider} trust policy to project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const { project_id, project_id2, ...rest } = input;
      const result = await addTrustPolicy({ projectId: project_id, ...(project_id2 ? { projectId2: project_id2 } : {}), ...rest });
      return {
        data: { executed: true, dry_run: false, trust_policy: result?.trustPolicy ?? result },
        audit: { before: null, after: input },
        summary: `Added ${input.provider} trust policy to Depot project ${input.project_id}.`,
      };
    },
  }, callerHash);
}

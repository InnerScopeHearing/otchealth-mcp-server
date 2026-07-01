import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listArtifacts } from '../../depot/full-client.js';

export function registerDepotArtifactsList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_artifacts_list',
    category: 'read',
    annotations: {
      title: 'Depot CI: list artifacts',
      description: 'List CI artifact metadata for a Depot CI run, optionally narrowed to a workflow, job, or attempt. Download URLs not included — use depot_artifact_url_get separately. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      run_id: z.string().describe('The Depot CI run ID.'),
      workflow_id: z.string().optional().describe('Narrow to artifacts from a specific workflow.'),
      job_id: z.string().optional().describe('Narrow to artifacts from a specific job.'),
      attempt_id: z.string().optional().describe('Narrow to artifacts from a specific attempt.'),
    },
    outputShape: {
      artifacts: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const result = await listArtifacts({
        runId: input.run_id,
        workflowId: input.workflow_id,
        jobId: input.job_id,
        attemptId: input.attempt_id,
      });
      const artifacts = result?.artifacts ?? [];
      return {
        data: { artifacts, count: artifacts.length },
        summary: `${artifacts.length} artifact(s) for run ${input.run_id}.`,
      };
    },
  }, callerHash);
}

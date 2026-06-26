import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getFailureDiagnosis } from '../../depot/full-client.js';

export function registerDepotFailureDiagnosisGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_failure_diagnosis_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get failure diagnosis',
      description: 'Get an AI-generated failure diagnosis for a Depot CI run, workflow, job, or attempt. Provide at least one ID. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      run_id: z.string().optional().describe('Diagnose failures at the run level.'),
      workflow_id: z.string().optional().describe('Diagnose failures at the workflow level.'),
      job_id: z.string().optional().describe('Diagnose failures at the job level.'),
      attempt_id: z.string().optional().describe('Diagnose failures at the attempt level.'),
    },
    outputShape: {
      diagnosis: z.unknown(),
    },
    handler: async (input) => {
      const result = await getFailureDiagnosis({
        runId: input.run_id,
        workflowId: input.workflow_id,
        jobId: input.job_id,
        attemptId: input.attempt_id,
      });
      return {
        data: { diagnosis: result },
        summary: 'Failure diagnosis fetched.',
      };
    },
  }, callerHash);
}

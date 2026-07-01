import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listWorkflows } from '../../depot/full-client.js';

export function registerDepotWorkflowList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_workflow_list',
    category: 'read',
    annotations: {
      title: 'Depot CI: list workflows',
      description: 'List Depot CI workflows, newest first. Filter by name, repo, status, trigger, SHA, or PR. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      repo: z.string().optional().describe('Filter by GitHub repo "owner/name".'),
      name: z.string().optional().describe('Text to match against workflow name or file path.'),
      status: z.array(z.enum(['queued', 'running', 'finished', 'failed', 'cancelled'])).optional().describe('Filter by status.'),
      trigger: z.string().optional().describe('Filter by trigger event.'),
      sha: z.string().optional().describe('Commit SHA prefix (1-40 hex chars).'),
      pr: z.string().optional().describe('Pull request number.'),
      page_size: z.number().optional().describe('Max 200. Default 50.'),
    },
    outputShape: {
      workflows: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const result = await listWorkflows({
        repo: input.repo,
        name: input.name,
        status: input.status,
        trigger: input.trigger,
        sha: input.sha,
        pr: input.pr,
        pageSize: input.page_size,
      });
      const workflows = result?.workflows ?? [];
      return {
        data: { workflows, count: workflows.length },
        summary: `${workflows.length} workflow(s) returned.`,
      };
    },
  }, callerHash);
}

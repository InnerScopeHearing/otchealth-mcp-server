import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjects } from '../../n8n/full-client.js';

export function registerN8nProjectList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_project_list',
    category: 'read',
    annotations: {
      title: 'List n8n projects',
      description:
        'List all projects in the n8n instance. Projects are organizational containers for workflows and credentials. Returns id, name, type, and createdAt.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().describe('Max results (default 100).'),
      cursor: z.string().optional().describe('Pagination cursor from previous response.'),
    },
    outputShape: {
      projects: z.array(z.unknown()),
      count: z.number(),
      next_cursor: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      const raw = await listProjects({
        limit: input.limit,
        cursor: input.cursor,
        correlationId: ctx.correlationId,
      });
      const projects = raw?.data ?? [];
      return {
        data: { projects, count: projects.length, next_cursor: raw?.nextCursor ?? null },
        summary: `Found ${projects.length} project(s).`,
      };
    },
  }, callerHash);
}

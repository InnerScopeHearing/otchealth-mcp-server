import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjects } from '../../depot/api-client.js';
export function registerDepotListProjects(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_list_projects', category: 'read',
    annotations: { title: 'List Depot projects', description: 'List Depot (depot.dev) build projects accessible via DEPOT_TOKEN. Read-only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: {}, outputShape: { projects: z.array(z.unknown()), count: z.number() },
    handler: async () => { const p = await listProjects(); return { data: { projects: p.map((x: any) => ({ id: x.projectId || x.id, name: x.name })), count: p.length }, summary: `${p.length} Depot project(s).` }; },
  }, callerHash);
}

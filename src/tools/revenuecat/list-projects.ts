import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjects } from '../../revenuecat/api-client.js';
export function registerRevenueCatListProjects(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_list_projects', category: 'read',
    annotations: { title: 'List RevenueCat projects', description: 'List RevenueCat projects (subscriptions scoreboard). Read-only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: {}, outputShape: { projects: z.array(z.unknown()), count: z.number() },
    handler: async () => { const r:any = await listProjects(); const items = r.items ?? r.projects ?? []; return { data: { projects: items.map((p:any)=>({id:p.id,name:p.name})), count: items.length }, summary: `${items.length} RevenueCat project(s).` }; },
  }, callerHash);
}

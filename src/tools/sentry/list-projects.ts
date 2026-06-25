import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjects } from '../../sentry/api-client.js';
export function registerSentryListProjects(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_list_projects', category: 'read',
    annotations: { title: 'List Sentry projects', description: 'List Sentry projects in the org (MedReview PHI projects are carved out). Read-only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: {}, outputShape: { projects: z.array(z.unknown()), count: z.number() },
    handler: async () => { const p = await listProjects(); return { data: { projects: p.map((x:any)=>({slug:x.slug,name:x.name,platform:x.platform})), count: p.length }, summary: `${p.length} Sentry project(s) (PHI carved out).` }; },
  }, callerHash);
}

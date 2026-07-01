import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjects } from '../../posthog/api-client.js';
export function registerPostHogListProjects(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_list_projects', category: 'read',
    annotations: { title: 'List PostHog projects', description: 'List PostHog projects in the current organization (MedReview PHI project 468398 is carved out). Read-only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: {}, outputShape: { projects: z.array(z.unknown()), count: z.number() },
    handler: async () => { const p = await listProjects(); return { data: { projects: p.map((x: any) => ({ id: x.id, name: x.name })), count: p.length }, summary: `${p.length} PostHog project(s) (MedReview PHI carved out).` }; },
  }, callerHash);
}

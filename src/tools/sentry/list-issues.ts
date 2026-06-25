import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listIssues } from '../../sentry/api-client.js';
export function registerSentryListIssues(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_list_issues', category: 'read',
    annotations: { title: 'List Sentry issues', description: 'List unresolved Sentry issues for a project (by slug). MedReview PHI projects are blocked. Read-only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: { project: z.string().describe('Project slug, e.g. "iheartest", "companion-mobile". MedReview is blocked.'), statsPeriod: z.string().optional().describe('Time window, e.g. "24h", "14d" (default 14d).') },
    outputShape: { issues: z.array(z.unknown()), count: z.number() },
    handler: async (input) => { const i = await listIssues(input.project, input.statsPeriod ?? '14d'); return { data: { issues: i.map((x:any)=>({shortId:x.shortId,title:x.title,count:x.count,userCount:x.userCount,level:x.level,lastSeen:x.lastSeen})), count: i.length }, summary: `${i.length} unresolved issue(s) in ${input.project}.` }; },
  }, callerHash);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { auditUnused } from '../../catalog/catalog.js';

export function registerCatalogAuditUnused(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'catalog_audit_unused',
    category: 'read',
    annotations: {
      title: 'Audit unused capabilities',
      description: 'The "do not leave features on the table" audit: planned services with no tools yet, wired services that still have un-wired API surface, and any wired service missing a catalog entry. Use to find the highest-value gateway work to build next.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape: {},
    outputShape: {
      planned_services: z.array(z.object({
        service: z.string(),
        description: z.string(),
        planned_tools: z.array(z.string()),
      })),
      partial_coverage: z.array(z.object({
        service: z.string(),
        wired_count: z.number(),
        available_not_wired: z.array(z.string()),
      })),
      undocumented_services: z.array(z.string()),
      summary: z.string(),
    },
    handler: async (_input, _ctx) => {
      const audit = auditUnused();
      return { data: audit, summary: audit.summary };
    },
  }, callerHash);
}

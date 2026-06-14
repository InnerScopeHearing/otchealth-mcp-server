import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { serviceCapabilities } from '../../catalog/catalog.js';

export function registerCatalogServiceCapabilities(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'catalog_service_capabilities',
    category: 'read',
    annotations: {
      title: 'Service capabilities',
      description: 'For one service (e.g. "stripe", "depot", "posthog"): its description, ring, auth, status (wired|planned), the tools currently wired, and the known API surface that is available but NOT yet wired. Use to decide whether a capability exists or needs building.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape: {
      service: z.string().min(1).describe('Service key (the tool-name prefix), e.g. "stripe", "cloudflare", "depot".'),
    },
    outputShape: {
      service: z.string(),
      known: z.boolean(),
      description: z.string().nullable(),
      ring: z.string(),
      auth: z.string().nullable(),
      status: z.string(),
      wired_tools: z.array(z.string()),
      available_not_wired: z.array(z.string()),
    },
    handler: async (input, _ctx) => {
      const caps = serviceCapabilities(input.service);
      return {
        data: caps,
        summary: caps.known
          ? `${input.service}: ${caps.status}, ${caps.wired_tools.length} wired, ${caps.available_not_wired.length} available-not-wired (ring: ${caps.ring}).`
          : `${input.service}: no catalog entry; ${caps.wired_tools.length} wired tool(s).`,
      };
    },
  }, callerHash);
}

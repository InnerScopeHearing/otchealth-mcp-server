import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, connectorToolset, type CallerHashProvider } from '../registry.js';
import { listTools } from '../../catalog/catalog.js';
import { catalogVersion } from '../../catalog/catalog.js';
import { loadEnv } from '../../config/env.js';
import { currentCallerAgent, isConnectorSurface } from '../../server/request-context.js';

export type CatalogServiceTools = ReadonlyArray<{ tools: ReadonlyArray<{ name: string }> }>;

/** Projects the already-listed global catalog into the caller's advertised surface. */
export function projectCallerSurfaceTools(
  services: CatalogServiceTools,
  connectorSurface: boolean,
  callerSurfaceSet?: ReadonlySet<string>,
): { mode: 'connector_allowlist' | 'full'; tools: string[] } {
  const tools = services.flatMap((service) => service.tools.map((tool) => tool.name));
  const mode = connectorSurface ? 'connector_allowlist' : 'full';
  return { mode, tools: connectorSurface && callerSurfaceSet ? tools.filter((name) => callerSurfaceSet.has(name)) : tools };
}

export function registerCatalogListTools(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'catalog_list_tools',
    category: 'read',
    annotations: {
      title: 'List gateway tools',
      description: 'Self-describe the gateway: every wired tool grouped by service, with category and read/write lane. Optionally filter to one service. Use this to discover what the gateway can do before calling anything. Also returns catalog_version — a short fingerprint of the current tool set (name+category, sorted) that changes whenever a tool is added/removed/recategorized. A client that caches its own MCP tools/list (e.g. across a reconnect) can compare this against the version it saw last time to detect a STALE cache — a full reconnect is not guaranteed to refresh a client-side tool cache, so a "missing" tool may be a stale cache, not an actual gap. When in doubt whether a tool exists, call this tool directly rather than trusting a cached tools/list.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape: {
      service: z.string().optional().describe('Filter to a single service (e.g. "stripe", "cloudflare").'),
    },
    outputShape: {
      services: z.array(z.object({
        service: z.string(),
        tool_count: z.number(),
        tools: z.array(z.object({
          name: z.string(),
          category: z.string(),
          read_only: z.boolean(),
          title: z.string(),
        })),
      })),
      total_tools: z.number(),
      total_services: z.number(),
      catalog_version: z.string(),
      caller_agent: z.string(),
      connector_surface: z.boolean(),
      caller_surface_mode: z.enum(['connector_allowlist', 'full']),
      caller_surface_tool_count: z.number(),
      caller_surface_tools: z.array(z.string()),
    },
    handler: async (input, _ctx) => {
      const services = listTools(input.service);
      const total = services.reduce((acc, s) => acc + s.tool_count, 0);
      const version = catalogVersion();
      const callerAgent = currentCallerAgent();
      const connectorSurface = isConnectorSurface();
      const callerSurfaceSet = connectorSurface ? connectorToolset(loadEnv(), callerAgent) : undefined;
      const callerSurface = projectCallerSurfaceTools(services, connectorSurface, callerSurfaceSet);
      const callerSurfaceTools = callerSurface.tools;
      const callerSurfaceMode = callerSurface.mode;
      return {
        data: {
          services,
          total_tools: total,
          total_services: services.length,
          catalog_version: version,
          caller_agent: callerAgent,
          connector_surface: connectorSurface,
          caller_surface_mode: callerSurfaceMode,
          caller_surface_tool_count: callerSurfaceTools.length,
          caller_surface_tools: callerSurfaceTools,
        },
        summary: `${total} tool(s) across ${services.length} service(s)${input.service ? ` (filtered to ${input.service})` : ''}. catalog_version=${version} — compare against your last-cached version to detect a stale tools/list. caller_surface=${callerSurfaceMode} (${callerSurfaceTools.length} tool(s)).`,
      };
    },
  }, callerHash);
}

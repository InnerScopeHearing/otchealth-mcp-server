import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { revisionInfo } from '../../server/revision.js';
import { callerSurfaceToolsFor, registerTool, type CallerHashProvider } from '../registry.js';
import { allTools } from '../../catalog/catalog.js';
import { currentCallerAgent, isConnectorSurface, isM365StaticAuth } from '../../server/request-context.js';
import { ctoWorkspaceForRequest } from './cto-workspace-profile.mjs';
import { callerSurfaceFingerprint } from '../catalog/caller-surface-fingerprint.js';
import { searchDiscoveryTools } from '../catalog/discovery-search.js';

/**
 * catalog_probe — minimal, always-available diagnostic tool (2026-07-26).
 * Default response remains a small build/registry/auth diagnostic. The explicit
 * include_cto_workspace option additionally returns a versioned CTO operating
 * profile, only for the server-authenticated cto lane. The profile is configuration,
 * not proof of execution permissions, ChatGPT activation, or subagent capacity.
 * No credentials, ring policy, or other agents' permissions are changed here.
 */
const BUILD_TAG = 'catalog-probe-2026-07-26.1';

export function registerCatalogProbe(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'catalog_probe',
      category: 'read',
      annotations: {
        title: 'Diagnostic: gateway build + registry + caller-auth probe',
        description:
          'Minimal diagnostic tool: returns a build tag, global registry count, this caller’s exact tools/list fingerprint and authentication context. Set discovery_query to search only this caller’s currently exposed tools; results are bounded to 10 and omit schemas unless include_schema=true. Authenticated CTO callers may explicitly set include_cto_workspace=true for the versioned operating profile. Registry presence never proves authorization or live execution.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        include_cto_workspace: z.boolean().optional().default(false),
        discovery_query: z.string().max(120).optional(),
        discovery_limit: z.number().int().min(1).max(10).optional(),
        include_schema: z.boolean().optional().default(false),
      },
      outputShape: {
        build_tag: z.string(),
        revision: z.object({
          image: z.string().nullable(),
          image_tag: z.string().nullable(),
          image_digest: z.string().nullable(),
          task_definition: z.string().nullable(),
          started_at: z.string(),
          uptime_seconds: z.number(),
          source_error: z.string().nullable(),
        }),
        tool_registry_count: z.number(),
        tool_registry_scope: z.literal('global_catalog'),
        caller_surface_fingerprint: z.string(),
        caller_surface_tool_count: z.number(),
        discovery: z.object({
          matches: z.array(z.object({
            name: z.string(),
            description: z.string().optional(),
            inputSchema: z.record(z.unknown()).optional(),
          })),
          totalMatches: z.number(),
          truncated: z.boolean(),
          schema_included: z.boolean().optional(),
          schema_omitted_reason: z.enum(['exact_tool_name_required', 'schema_too_large', 'schema_unavailable']).optional(),
        }).optional(),
        known_tools_present: z.record(z.boolean()),
        request_context: z.object({
          caller_agent: z.string(),
          is_m365_static_auth: z.boolean(),
          is_connector_surface: z.boolean(),
        }),
        cto_workspace: z.record(z.unknown()).optional(),
      },
      handler: async ({ include_cto_workspace, discovery_query, discovery_limit, include_schema }) => {
        const registered = allTools().map((t) => t.name);
        const callerTools = callerSurfaceToolsFor(server);
        const registeredSet = new Set(registered);
        // Auth is derived ONLY from the server request context; input cannot pick a lane.
        const workspace = ctoWorkspaceForRequest(include_cto_workspace, currentCallerAgent(), registered);
        const probeNames = [
          'github_repo_get',
          'github_workflow_run_list_jobs',
          'github_branch_get_protection',
          'depot_artifacts_list',
          'developer_wake_lite',
          'catalog_probe',
        ];
        const knownToolsPresent: Record<string, boolean> = {};
        for (const n of probeNames) knownToolsPresent[n] = registeredSet.has(n);

        const data = {
          build_tag: BUILD_TAG,
          revision: await revisionInfo(),
          tool_registry_count: registered.length,
          tool_registry_scope: 'global_catalog',
          caller_surface_fingerprint: callerSurfaceFingerprint(callerTools),
          caller_surface_tool_count: callerTools.length,
          ...(discovery_query === undefined ? {} : {
            discovery: (() => {
              const result = searchDiscoveryTools(callerTools, {
                query: discovery_query,
                limit: include_schema ? 1 : discovery_limit,
                includeSchema: false,
              });
              if (!include_schema) return result;
              const exactTool = callerTools.find((tool) => tool.name.toLowerCase() === discovery_query.trim().toLowerCase());
              if (!exactTool) {
                return { matches: [], totalMatches: 0, truncated: false, schema_included: false, schema_omitted_reason: 'exact_tool_name_required' as const };
              }
              if (!exactTool.inputSchema) {
                return { ...result, schema_included: false, schema_omitted_reason: 'schema_unavailable' as const };
              }
              if (Buffer.byteLength(JSON.stringify(exactTool.inputSchema), 'utf8') > 64 * 1024) {
                return { matches: result.matches.slice(0, 1), totalMatches: 1, truncated: false, schema_included: false, schema_omitted_reason: 'schema_too_large' as const };
              }
              return {
                ...result,
                matches: [{ name: exactTool.name, ...(typeof exactTool.description === 'string' ? { description: exactTool.description.slice(0, 160) } : {}), inputSchema: exactTool.inputSchema }],
                totalMatches: 1,
                truncated: false,
                schema_included: true,
              };
            })(),
          }),
          known_tools_present: knownToolsPresent,
          request_context: {
            caller_agent: currentCallerAgent(),
            is_m365_static_auth: isM365StaticAuth(),
            is_connector_surface: isConnectorSurface(),
          },
          ...(workspace === undefined ? {} : { cto_workspace: workspace }),
        };
        return {
          data,
          summary: `catalog_probe: build=${BUILD_TAG}, registry=${registered.length} tools, caller_agent=${data.request_context.caller_agent || '(none)'}, m365StaticAuth=${data.request_context.is_m365_static_auth}, connectorSurface=${data.request_context.is_connector_surface}${workspace ? `, CTO workspace profile=${workspace.version} (activation unverified)` : ''}`,
        };
      },
    },
    callerHash,
  );
}

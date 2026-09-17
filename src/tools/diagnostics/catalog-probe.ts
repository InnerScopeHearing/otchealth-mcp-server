import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { revisionInfo } from '../../server/revision.js';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { allTools } from '../../catalog/catalog.js';
import { currentCallerAgent, isConnectorSurface, isM365StaticAuth } from '../../server/request-context.js';
import { ctoWorkspaceForRequest } from './cto-workspace-profile.mjs';

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
          'Minimal diagnostic tool: returns a build tag, registered tool count, known tool presence and the authentication context of this exact call. The default response stays small. Authenticated CTO callers may explicitly set include_cto_workspace=true to also retrieve the versioned CTO operating instructions and unverified capability checklist. Registry presence never proves authorization or live execution. The workspace profile does not create a ChatGPT Project or grant permissions.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        include_cto_workspace: z.boolean().optional().default(false),
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
        known_tools_present: z.record(z.boolean()),
        request_context: z.object({
          caller_agent: z.string(),
          is_m365_static_auth: z.boolean(),
          is_connector_surface: z.boolean(),
        }),
        cto_workspace: z.record(z.unknown()).optional(),
      },
      handler: async ({ include_cto_workspace }) => {
        const registered = allTools().map((t) => t.name);
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
          summary: `catalog_probe: build=${BUILD_TAG}, registry=${registered.length} tools, caller_agent=${data.request_context.caller_agent || '(none)'}, m365StaticAuth=${data.request_context.is_m365_static_auth}, connectorSurface=${data.request_context.is_connector_surface}${workspace ? ', CTO workspace profile=1.0.0 (activation unverified)' : ''}`,
        };
      },
    },
    callerHash,
  );
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { allTools } from '../../catalog/catalog.js';
import { currentCallerAgent, isConnectorSurface, isM365StaticAuth } from '../../server/request-context.js';

/**
 * catalog_probe — minimal, always-available diagnostic tool (2026-07-26). Built specifically to
 * resolve a live ambiguity the M365 Developer agent could not resolve from inside its own runtime:
 * whether the M365 declarative agent has actually ingested the current gateway/manifest (still
 * only ~20 tools visible after manual uninstall/reinstall, expected 120), and whether
 * isM365StaticAuth() detection is firing correctly for a given caller's tool calls (wake() with
 * recent_limit=1/memory_limit=1/task_limit=1 STILL returned "no content available", ruling out
 * "the normal payload is just too big" as the sole explanation).
 *
 * Deliberately tiny and STATIC shape: no branching on caller identity for its OWN size (unlike
 * wake()), so it can never itself hit a response-size ceiling. If THIS tool also returns "no
 * content available" in M365 Copilot, that is decisive evidence the problem is Copilot-side
 * suppression/ingestion of tool output in general, not anything specific to wake()'s payload
 * shape, size, or the isM365StaticAuth() branch inside it.
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
          'Minimal diagnostic tool: returns a build tag, the total registered tool count, whether a handful of recently-added tools are present in the live registry, and -- most importantly -- how THIS EXACT CALL was authenticated (caller_agent, is_m365_static_auth, is_connector_surface). Use this to tell apart "the M365 app has not ingested the new manifest" from "the manifest is live but the auth-detection branch has a bug" from "the client suppresses tool output for reasons unrelated to size or shape". Always tiny (well under 1KB serialized) -- if even this returns no content in a given client, the issue is that client, not this gateway.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {},
      outputShape: {
        build_tag: z.string(),
        tool_registry_count: z.number(),
        known_tools_present: z.record(z.boolean()),
        request_context: z.object({
          caller_agent: z.string(),
          is_m365_static_auth: z.boolean(),
          is_connector_surface: z.boolean(),
        }),
      },
      handler: async () => {
        const registered = allTools().map((t) => t.name);
        const registeredSet = new Set(registered);
        // A small, fixed probe list mixing tools that SHOULD already exist (sanity check the
        // probe itself works) with tools specifically called out as "still missing" in the
        // M365 Developer agent's live self-audit (2026-07-26) -- if these read true here but
        // false in what Copilot can call, that pins the gap to Copilot's ingestion, not the
        // gateway's own registration.
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
          tool_registry_count: registered.length,
          known_tools_present: knownToolsPresent,
          request_context: {
            caller_agent: currentCallerAgent(),
            is_m365_static_auth: isM365StaticAuth(),
            is_connector_surface: isConnectorSurface(),
          },
        };
        return {
          data,
          summary: `catalog_probe: build=${BUILD_TAG}, registry=${registered.length} tools, caller_agent=${data.request_context.caller_agent || '(none)'}, m365StaticAuth=${data.request_context.is_m365_static_auth}, connectorSurface=${data.request_context.is_connector_surface}`,
        };
      },
    },
    callerHash,
  );
}

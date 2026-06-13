import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, getRegisteredTools, type CallerHashProvider } from '../registry.js';
import { getServiceManifest, listServiceNames } from '../../catalog/manifest.js';

/**
 * For a service, return its full known upstream surface from the hand-maintained
 * manifest, each capability flagged WIRED vs AVAILABLE-NOT-WIRED. Cross-checks
 * the manifest's declared `wired` against the tools actually registered at
 * runtime, so a drift (manifest says wired but no tool exists, or vice-versa)
 * surfaces instead of hiding.
 */
function serviceOf(toolName: string): string {
  const prefix = toolName.split('_')[0] ?? 'other';
  if (prefix === 'cio') return 'customerio';
  return prefix;
}

export function registerCatalogServiceCapabilities(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'catalog_service_capabilities',
      category: 'read',
      annotations: {
        title: 'Capabilities of one service (WIRED vs AVAILABLE-NOT-WIRED)',
        description:
          'For a given upstream service, list its known capabilities from the manifest, each flagged WIRED (a gateway tool exists) or AVAILABLE-NOT-WIRED (a feature on the table). Cross-checks against the live tool registry to surface drift.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        service: z.string().describe(`One of: ${listServiceNames().join(', ')}.`),
      },
      outputShape: {
        service: z.string(),
        summary: z.string(),
        ring: z.string(),
        wired: z.array(z.unknown()),
        available_not_wired: z.array(z.unknown()),
        drift: z.array(z.unknown()),
      },
      handler: async (input, _ctx) => {
        const manifest = getServiceManifest(input.service);
        if (!manifest) {
          return {
            data: {
              service: input.service,
              summary: '',
              ring: '',
              wired: [],
              available_not_wired: [],
              drift: [{ issue: 'unknown_service', detail: `No manifest for "${input.service}". Known: ${listServiceNames().join(', ')}.` }],
            },
            summary: `No manifest entry for service "${input.service}".`,
          };
        }
        const liveToolNames = new Set(
          getRegisteredTools().filter((t) => serviceOf(t.name) === manifest.service).map((t) => t.name),
        );
        const wired = manifest.capabilities.filter((c) => c.wired);
        const availableNotWired = manifest.capabilities.filter((c) => !c.wired);

        // Drift detection: manifest says wired but the named tool is not registered.
        const drift: Array<{ issue: string; detail: string }> = [];
        for (const c of wired) {
          if (c.toolName && !liveToolNames.has(c.toolName)) {
            drift.push({
              issue: 'wired_but_missing_tool',
              detail: `Capability "${c.id}" is marked wired -> ${c.toolName}, but that tool is not registered.`,
            });
          }
        }

        return {
          data: {
            service: manifest.service,
            summary: manifest.summary,
            ring: manifest.ring,
            wired: wired.map((c) => ({ id: c.id, description: c.description, tool: c.toolName, write_class: c.writeClass, note: c.note })),
            available_not_wired: availableNotWired.map((c) => ({ id: c.id, description: c.description, write_class: c.writeClass, note: c.note })),
            drift,
          },
          summary: `${manifest.service}: ${wired.length} wired, ${availableNotWired.length} available-not-wired${drift.length ? `, ${drift.length} drift warning(s)` : ''}.`,
        };
      },
    },
    callerHash,
  );
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { CATALOG } from '../../catalog/manifest.js';

/**
 * catalog_audit_unused, the "features on the table" report. Across every
 * service in the manifest, collect the AVAILABLE-NOT-WIRED capabilities (known
 * upstream features with no gateway tool yet). This is the deliberate gap list
 * Matt asked for so we never leave grant/plan features unused by accident.
 *
 * Capabilities intentionally never-wired (the PHI carve-out replay/person tools)
 * are excluded from the "should we wire this?" list and reported separately so
 * they are not mistaken for an oversight.
 */
export function registerCatalogAuditUnused(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'catalog_audit_unused',
      category: 'read',
      annotations: {
        title: 'Audit unused upstream capabilities (features on the table)',
        description:
          'Across all services, the AVAILABLE-NOT-WIRED capabilities (known upstream features with no gateway tool yet). The deliberate gap report so grant/plan features are not left unused by accident. Intentionally-never-wired PHI carve-out capabilities are listed separately.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        include_intentional: z
          .boolean()
          .optional()
          .describe('If true, also list the intentionally-never-wired (PHI carve-out) capabilities. Default false.'),
      },
      outputShape: {
        unused: z.array(z.unknown()),
        unused_count: z.number(),
        intentionally_never_wired: z.array(z.unknown()),
        wired_count: z.number(),
        total_capabilities: z.number(),
      },
      handler: async (input, _ctx) => {
        const unused: Array<{ service: string; id: string; description: string; write_class: string; note?: string }> = [];
        const intentional: Array<{ service: string; id: string; reason: string }> = [];
        let wiredCount = 0;
        let total = 0;
        for (const svc of CATALOG) {
          for (const c of svc.capabilities) {
            total += 1;
            if (c.wired) {
              wiredCount += 1;
              continue;
            }
            const note = c.note ?? '';
            const isIntentional = /INTENTIONALLY NEVER WIRED/i.test(note);
            if (isIntentional) {
              intentional.push({ service: svc.service, id: c.id, reason: note });
              continue;
            }
            unused.push({
              service: svc.service,
              id: c.id,
              description: c.description,
              write_class: c.writeClass,
              ...(c.note ? { note: c.note } : {}),
            });
          }
        }
        return {
          data: {
            unused,
            unused_count: unused.length,
            intentionally_never_wired: input.include_intentional ? intentional : [],
            wired_count: wiredCount,
            total_capabilities: total,
          },
          summary: `${unused.length} capability(ies) available-not-wired across ${CATALOG.length} services (${wiredCount}/${total} wired). ${intentional.length} intentionally never wired (PHI carve-out).`,
        };
      },
    },
    callerHash,
  );
}

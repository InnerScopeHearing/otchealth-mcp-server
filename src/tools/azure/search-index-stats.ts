import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { searchIndexDocCount, azureConfig, assertNonPhiTarget } from '../../azure/arm-client.js';

export function registerAzureSearchIndexStats(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_search_index_stats',
      category: 'read',
      annotations: {
        title: 'Azure AI Search: index document count',
        description:
          'Exact document count for an Azure AI Search index via a read-only count query (search=*, count=true). Use it to prove an index is populated and healthy (e.g. memory-exec or finance-cfo-source-docs on otchealth-dataroom-s1, the LIVE service). Auto-detects the hosting service from the configured list if you do not name one. Read-only; never returns the API key.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        index: z.string().min(1).describe('The index name, e.g. otchealth-brain, memory-exec.'),
        service: z
          .string()
          .optional()
          .describe('Search service name (default: otchealth-dataroom-s1, the live service). Omit to auto-detect.'),
      },
      outputShape: { service: z.string(), index: z.string(), documentCount: z.number() },
      handler: async (input) => {
        const { searchServices } = azureConfig();
        assertNonPhiTarget(input.index, input.service);
        const candidates = input.service ? [input.service] : searchServices;
        let lastErr: Error | null = null;
        for (const svc of candidates) {
          try {
            const documentCount = await searchIndexDocCount(svc, input.index);
            return {
              data: { service: svc, index: input.index, documentCount },
              summary: `Index ${input.index} on ${svc}: ${documentCount.toLocaleString()} document(s).`,
            };
          } catch (err) {
            const e = err as Error;
            // Index simply not on this service -> try the next candidate. Any other error (auth,
            // network, service down) is real and must surface, not be masked as "not found".
            if (/-> 404\b/.test(e.message) || /No index with the name/i.test(e.message)) {
              lastErr = e;
              continue;
            }
            throw e;
          }
        }
        throw new Error(
          `index "${input.index}" not found on ${candidates.join(', ')}${lastErr ? ` (last: ${lastErr.message})` : ''}.`,
        );
      },
    },
    callerHash,
  );
}

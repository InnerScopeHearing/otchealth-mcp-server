import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertAzureToolLive, retiredDescription } from '../../azure/retired.js';
import { searchResourcePut, assertNonPhiTarget } from '../../azure/arm-client.js';

export function registerAzureSearchIndexerUpsert(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_search_indexer_upsert',
      category: 'write_orchestrated',
      annotations: {
        title: 'Azure AI Search: create/update an indexer',
        description: retiredDescription(
          'azure_search_indexer_upsert',
          'Create or update an Azure AI Search indexer (data-plane PUT: dataSourceName, targetIndexName, schedule, fieldMappings, skillset). Drives native indexing + integrated vectorization. NO delete. dry_run defaults TRUE; pass dry_run=false to apply. CTO-only, high-risk-gated. Never returns the API key.'
        ),
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        service: z.string().min(1).describe('Search service name.'),
        indexer_name: z.string().min(1).describe('Indexer name.'),
        definition: z.record(z.unknown()).describe('The indexer definition (dataSourceName, targetIndexName, schedule, fieldMappings, skillsetName). `name` is set from indexer_name.'),
      },
      outputShape: { upserted: z.boolean(), indexer: z.string(), dry_run: z.boolean() },
      handler: async (input, ctx) => {
        // RETIRED (see src/azure/retired.ts). Fails immediately -- before input handling,
        // before the dry-run branch, before any auth or network attempt -- with a named,
        // actionable error rather than a vague auth failure or a plausible dry-run plan.
        assertAzureToolLive('azure_search_indexer_upsert');
        assertNonPhiTarget(input.indexer_name, input.service);
        const target = (input.definition as { targetIndexName?: string }).targetIndexName;
        assertNonPhiTarget(target);
        if (ctx.dryRun) {
          return {
            data: { upserted: false, indexer: input.indexer_name, dry_run: true, planned: { service: input.service, targetIndexName: target } },
            summary: `DRY RUN: would PUT indexer ${input.indexer_name} on ${input.service} -> index ${target || '(unset)'}. Pass dry_run=false to apply.`,
          };
        }
        const res = await searchResourcePut(input.service, 'indexers', input.indexer_name, input.definition);
        return {
          data: { upserted: true, indexer: input.indexer_name, dry_run: false, status: res.status },
          summary: `Upserted indexer ${input.indexer_name} on ${input.service} (${res.status}).`,
          audit: { after: { service: input.service, indexer: input.indexer_name, targetIndexName: target } },
        };
      },
    },
    callerHash,
  );
}

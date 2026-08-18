import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertAzureToolLive, retiredDescription } from '../../azure/retired.js';
import { searchResourcePut, assertNonPhiTarget } from '../../azure/arm-client.js';

export function registerAzureSearchIndexUpsert(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_search_index_upsert',
      category: 'write_orchestrated',
      annotations: {
        title: 'Azure AI Search: create/update an index',
        description: retiredDescription(
          'azure_search_index_upsert',
          'Create or update an Azure AI Search index (data-plane PUT of the index definition: fields, analyzers, vector/semantic config). Enables native indexers + integrated vectorization. NO delete. dry_run defaults TRUE (returns the target + a field summary); pass dry_run=false to apply. CTO-only, high-risk-gated. Never returns the API key.'
        ),
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        service: z.string().min(1).describe('Search service name (the live service is otchealth-dataroom-s1).'),
        index_name: z.string().min(1).describe('Index name.'),
        definition: z.record(z.unknown()).describe('The index definition (fields[], plus optional semantic/vectorSearch config). `name` is set from index_name.'),
      },
      outputShape: { upserted: z.boolean(), index: z.string(), dry_run: z.boolean() },
      handler: async (input, ctx) => {
        // RETIRED (see src/azure/retired.ts). Fails immediately -- before input handling,
        // before the dry-run branch, before any auth or network attempt -- with a named,
        // actionable error rather than a vague auth failure or a plausible dry-run plan.
        assertAzureToolLive('azure_search_index_upsert');
        assertNonPhiTarget(input.index_name, input.service);
        const fields = (input.definition as { fields?: unknown[] }).fields;
        const fieldCount = Array.isArray(fields) ? fields.length : 0;
        if (ctx.dryRun) {
          return {
            data: { upserted: false, index: input.index_name, dry_run: true, planned: { service: input.service, fields: fieldCount } },
            summary: `DRY RUN: would PUT index ${input.index_name} on ${input.service} (${fieldCount} field(s)). Pass dry_run=false to apply.`,
          };
        }
        const res = await searchResourcePut(input.service, 'indexes', input.index_name, input.definition);
        return {
          data: { upserted: true, index: input.index_name, dry_run: false, status: res.status },
          summary: `Upserted index ${input.index_name} on ${input.service} (${res.status}).`,
          audit: { after: { service: input.service, index: input.index_name, fields: fieldCount } },
        };
      },
    },
    callerHash,
  );
}

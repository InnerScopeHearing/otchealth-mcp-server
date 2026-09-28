import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createCompanySharedSyntheticRelationshipQuery } from '../../server/company-shared-synthetic-relationship.mjs';
import { isConnectorSurface } from '../../server/request-context.js';
import { registerTool, type CallerHashProvider } from '../registry.js';

export function registerCompanySharedSyntheticRelationshipQuery(server: McpServer, callerHash: CallerHashProvider, injected?: (input: { subject_id: 'X' | 'Y' | 'Z'; object_id: 'X' | 'Y' | 'Z' }) => Promise<unknown>): void {
  const query = injected ?? createCompanySharedSyntheticRelationshipQuery();
  registerTool(server, {
    name: 'graph_company_shared_relationship_query',
    category: 'read',
    annotations: {
      title: 'Validate shared typed relationships with a synthetic fixture',
      description: 'Synthetic-only CTO acceptance contract for the company_shared partition. The fixture is immutable X→Y→Z evidence with source-version citation receipts. No company sources, caller-selected history, store, producer, or partition are accepted.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputShape: {
      subject_id: z.enum(['X', 'Y', 'Z']),
      object_id: z.enum(['X', 'Y', 'Z']),
    },
    outputShape: {
      result: z.unknown().nullable(),
      error: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.callerAgent !== 'cto' || !isConnectorSurface()) {
        return { data: { result: null, error: 'forbidden_graph_scope' }, summary: 'Refused: this synthetic relationship contract is limited to the authenticated CTO connector.' };
      }
      try {
        const result = await query(input);
        return { data: { result }, summary: 'Replayed the fixed synthetic company_shared history. No company source publication was read.' };
      } catch {
        return { data: { result: null, error: 'shared_synthetic_query_unavailable' }, summary: 'The synthetic company_shared history or its citation currentness check failed closed.' };
      }
    },
  }, callerHash);
}

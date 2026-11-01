import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { n8nGet } from '../../n8n/api-client.js';
import { authorizedCooWorkflowMetadataIds } from './coo-workflow-metadata-scope.js';

const MAX_WORKFLOWS = 25;
const PAGE_SIZE = 2;
const MAX_RESPONSE_BYTES = 16 * 1024;
const SAFE_ERROR = 'Unable to list workflow metadata safely. Check server logs using the call correlation ID.';

type Workflow = { id: string; active?: boolean; createdAt?: string; updatedAt?: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function project(value: unknown): Workflow {
  if (!record(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)) throw new Error(SAFE_ERROR);
  const item: Workflow = { id: value.id };
  if (value.active !== undefined) {
    if (typeof value.active !== 'boolean') throw new Error(SAFE_ERROR);
    item.active = value.active;
  }
  for (const field of ['createdAt', 'updatedAt'] as const) {
    const v = value[field];
    if (v !== undefined) {
      if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v) || Number.isNaN(Date.parse(v))) throw new Error(SAFE_ERROR);
      item[field] = v;
    }
  }
  return item;
}

export function registerN8nCooWorkflowMetadata(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_coo_workflow_metadata',
    category: 'read',
    annotations: {
      title: 'List bounded workflow metadata',
      description: 'COO-only read of at most two allowlisted workflow IDs per call, with active states, timestamps, and the next allowlist offset. Names, tags, definitions, configuration, credentials, executions, and n8n cursors are excluded.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      offset: z.number().int().min(0).max(MAX_WORKFLOWS).optional().describe('Offset into the server-authorized workflow list, not an n8n cursor.'),
    },
    outputShape: {
      workflows: z.array(z.object({
        id: z.string(), active: z.boolean().optional(), createdAt: z.string().optional(), updatedAt: z.string().optional(),
      })),
      count: z.number(), next_offset: z.number().nullable(),
    },
    maxResponseBytes: MAX_RESPONSE_BYTES,
    handler: async (input, ctx) => {
      // Validate authorization scope before any reachability probe or request to n8n.
      let allAllowedIds: string[];
      try { allAllowedIds = [...authorizedCooWorkflowMetadataIds()]; }
      catch { throw new Error(SAFE_ERROR); }
      const offset = input.offset ?? 0;
      if (offset > allAllowedIds.length) throw new Error(SAFE_ERROR);
      const ids = allAllowedIds.slice(offset, offset + PAGE_SIZE);
      if (ids.length === 0) return { data: { workflows: [], count: 0, next_offset: null }, summary: 'Found 0 authorized workflow(s).' };
      try {
        const workflows: Workflow[] = [];
        // At most two concurrent exact-ID reads. The shared client may retry once, so keep each
        // attempt short enough to stay within ordinary MCP client budgets.
        for (let i = 0; i < ids.length; i += 2) {
          const batch = ids.slice(i, i + 2);
          const results = await Promise.all(batch.map(async (id) => {
            const upstream = await n8nGet<unknown>(`/workflows/${encodeURIComponent(id)}`, {
              correlationId: ctx.correlationId, timeoutMs: 3_000, maxResponseBytes: 262_144,
            });
            const metadata = project(upstream);
            if (metadata.id !== id) throw new Error(SAFE_ERROR);
            return metadata;
          }));
          workflows.push(...results);
        }
        const nextOffset = offset + ids.length < allAllowedIds.length ? offset + ids.length : null;
        return { data: { workflows, count: workflows.length, next_offset: nextOffset }, summary: `Found ${workflows.length} authorized workflow(s).` };
      } catch {
        throw new Error(SAFE_ERROR);
      }
    },
  }, callerHash);
}

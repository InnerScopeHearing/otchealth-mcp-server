import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { n8nGet } from '../../n8n/api-client.js';

const DEFAULT_WORKFLOW_LIST_LIMIT = 100;
const MAX_WORKFLOW_LIST_LIMIT = 250;
const MAX_WORKFLOW_LIST_RESPONSE_BYTES = 64 * 1024;

interface WorkflowTagMetadata {
  id?: string;
  name?: string;
}

interface WorkflowMetadata {
  id: string;
  name?: string;
  active?: boolean;
  tags?: WorkflowTagMetadata[];
  createdAt?: string;
  updatedAt?: string;
}

const INVALID_WORKFLOW_LIST_RESPONSE =
  'n8n returned invalid workflow list metadata. Check server logs using the call correlation ID.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyOptionalString(
  source: Record<string, unknown>,
  field: 'name' | 'createdAt' | 'updatedAt',
  target: WorkflowMetadata,
): void {
  const value = source[field];
  if (value === undefined) return;
  if (typeof value !== 'string') throw new Error(INVALID_WORKFLOW_LIST_RESPONSE);
  target[field] = value;
}

/**
 * Public list allowlist: id, name, active, tags.id, tags.name, createdAt, and updatedAt.
 * Workflow definitions and other properties are intentionally never copied into list results.
 */
function projectWorkflowMetadata(value: unknown): WorkflowMetadata {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error(INVALID_WORKFLOW_LIST_RESPONSE);
  }

  const projected: WorkflowMetadata = { id: value.id };
  copyOptionalString(value, 'name', projected);
  if (value.active !== undefined) {
    if (typeof value.active !== 'boolean') throw new Error(INVALID_WORKFLOW_LIST_RESPONSE);
    projected.active = value.active;
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags)) throw new Error(INVALID_WORKFLOW_LIST_RESPONSE);
    projected.tags = value.tags.map((tag): WorkflowTagMetadata => {
      if (!isRecord(tag)) throw new Error(INVALID_WORKFLOW_LIST_RESPONSE);
      const safeTag: WorkflowTagMetadata = {};
      if (tag.id !== undefined) {
        if (typeof tag.id !== 'string') throw new Error(INVALID_WORKFLOW_LIST_RESPONSE);
        safeTag.id = tag.id;
      }
      if (tag.name !== undefined) {
        if (typeof tag.name !== 'string') throw new Error(INVALID_WORKFLOW_LIST_RESPONSE);
        safeTag.name = tag.name;
      }
      return safeTag;
    });
  }
  copyOptionalString(value, 'createdAt', projected);
  copyOptionalString(value, 'updatedAt', projected);
  return projected;
}

function projectWorkflowListResponse(value: unknown, maxCount: number): {
  workflows: WorkflowMetadata[];
  count: number;
  next_cursor: string | null;
} {
  if (!isRecord(value)) throw new Error(INVALID_WORKFLOW_LIST_RESPONSE);
  const rawWorkflows = value.data ?? [];
  if (!Array.isArray(rawWorkflows) || rawWorkflows.length > maxCount) {
    throw new Error(INVALID_WORKFLOW_LIST_RESPONSE);
  }
  const rawCursor = value.nextCursor ?? null;
  if (rawCursor !== null && typeof rawCursor !== 'string') {
    throw new Error(INVALID_WORKFLOW_LIST_RESPONSE);
  }

  const workflows = rawWorkflows.map((workflow: unknown) => projectWorkflowMetadata(workflow));
  return { workflows, count: workflows.length, next_cursor: rawCursor };
}

export function registerN8nListWorkflows(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'n8n_list_workflows',
      category: 'read',
      annotations: {
        title: 'List n8n workflows',
        description:
          'List workflows on the n8n instance (cs-n8n.otchealthmart.com, AWS Lightsail recovery lane). Metadata allowlist: id, name, active, tags.id, tags.name, createdAt, updatedAt. Excludes nodes, connections, settings, staticData, and credential metadata. Page size defaults to 100 (maximum 250); serialized response is capped at 64 KiB.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        active: z.boolean().optional().describe('Filter to active=true or inactive=false workflows only.'),
        limit: z.number().int().min(1).max(MAX_WORKFLOW_LIST_LIMIT).optional()
          .describe('Maximum workflows to return (default 100, maximum 250).'),
        cursor: z.string().optional().describe('Pagination cursor from previous response.'),
        name: z.string().optional().describe('Filter by partial name match.'),
        tag: z.string().optional().describe('Filter by tag name (e.g., production, dormant, customerio).'),
      },
      outputShape: {
        workflows: z.array(z.object({
          id: z.string(),
          name: z.string().optional(),
          active: z.boolean().optional(),
          tags: z.array(z.object({
            id: z.string().optional(),
            name: z.string().optional(),
          })).optional(),
          createdAt: z.string().optional(),
          updatedAt: z.string().optional(),
        })),
        count: z.number(),
        next_cursor: z.string().nullable(),
      },
      maxResponseBytes: MAX_WORKFLOW_LIST_RESPONSE_BYTES,
      handler: async (input, ctx) => {
        const limit = input.limit ?? DEFAULT_WORKFLOW_LIST_LIMIT;
        const query: Record<string, string | number | undefined> = {};
        if (input.active !== undefined) query.active = input.active ? 'true' : 'false';
        query.limit = limit;
        if (input.cursor !== undefined) query.cursor = input.cursor;
        if (input.name !== undefined) query.name = input.name;
        if (input.tag !== undefined) query.tags = input.tag;

        let response: unknown;
        try {
          response = await n8nGet<unknown>('/workflows', {
            query,
            correlationId: ctx.correlationId,
          });
        } catch {
          throw new Error('Unable to list n8n workflow metadata safely. Check server logs using the call correlation ID.');
        }

        const result = projectWorkflowListResponse(response, limit);
        return {
          data: result,
          summary: `Found ${result.count} workflow(s).`,
        };
      },
    },
    callerHash,
  );
}

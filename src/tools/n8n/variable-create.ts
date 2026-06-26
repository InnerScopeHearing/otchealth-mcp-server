import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createVariable } from '../../n8n/full-client.js';

export function registerN8nVariableCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_variable_create',
    category: 'write_simple',
    annotations: {
      title: 'Create n8n variable',
      description:
        'Create a new n8n instance-level variable accessible to all workflows via $vars.<key>. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      key: z.string().min(1).describe('Variable key name (used as $vars.<key> in workflows).'),
      value: z.string().describe('Variable value (stored as string).'),
      type: z
        .enum(['string', 'number', 'boolean', 'object'])
        .optional()
        .describe('Variable type hint (default: string).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      variable_id: z.string().nullable(),
      key: z.string(),
      value: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, variable_id: null, key: input.key, value: input.value },
          audit: { before: null, after: { key: input.key, value: input.value, type: input.type } },
          summary: `DRY RUN: would create variable "${input.key}". Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createVariable({
        key: input.key,
        value: input.value,
        type: input.type,
        correlationId: ctx.correlationId,
      });
      return {
        data: {
          executed: true, dry_run: false,
          variable_id: upstream?.id ?? null,
          key: upstream?.key ?? input.key,
          value: upstream?.value ?? input.value,
        },
        audit: { before: null, after: { variable_id: upstream?.id, key: input.key } },
        summary: `Created variable "${input.key}" (id: ${upstream?.id ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}

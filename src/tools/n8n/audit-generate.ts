import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { generateAudit } from '../../n8n/full-client.js';

export function registerN8nAuditGenerate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_audit_generate',
    category: 'write_orchestrated',
    annotations: {
      title: 'Generate n8n security audit',
      description:
        'Trigger generation of a security audit report for the n8n instance. The report covers risks such as credentials exposed in node parameters, ' +
        'overly-permissive webhook configurations, abandoned workflows, and other security hygiene items. ' +
        'Classified write_orchestrated because it performs a deep instance scan that may be CPU-intensive. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      days_abandoned_workflow: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Number of days of inactivity after which a workflow is considered abandoned (default: 90).'),
      categories: z
        .array(z.string())
        .optional()
        .describe('Specific audit categories to include, e.g. ["credentials","nodes","instance"]. Omit for all.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      audit_report: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, audit_report: null },
          audit: { before: null, after: { days_abandoned_workflow: input.days_abandoned_workflow } },
          summary: `DRY RUN: would generate security audit report. Pass dry_run=false to apply.`,
        };
      }
      const report = await generateAudit({
        additionalOptions: {
          ...(input.days_abandoned_workflow !== undefined
            ? { daysAbandonedWorkflow: input.days_abandoned_workflow }
            : {}),
          ...(input.categories ? { categories: input.categories } : {}),
        },
        correlationId: ctx.correlationId,
      });
      return {
        data: { executed: true, dry_run: false, audit_report: report },
        audit: { before: null, after: { generated: true } },
        summary: 'Generated n8n security audit report.',
      };
    },
  }, callerHash);
}

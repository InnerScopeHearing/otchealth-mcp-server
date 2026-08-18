import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertAzureToolLive, retiredDescription } from '../../azure/retired.js';
import { logAnalyticsQuery, azureConfig } from '../../azure/arm-client.js';

export function registerAzureLogsQuery(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'azure_logs_query',
      category: 'read',
      annotations: {
        title: 'Azure: run a KQL query against Log Analytics',
        description: retiredDescription(
          'azure_logs_query',
          'Run a read-only KQL query against the log-otchealth-shared Log Analytics workspace (default). This is how you read Container Apps Job/console logs to diagnose a failing run (table ContainerAppConsoleLogs_CL) or gateway logs. KQL is inherently read-only; the gateway identity holds Log Analytics Reader on this one non-PHI workspace only. Read-only.'
        ),
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        kql: z.string().min(1).describe('The KQL query, e.g. `ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith "daily-digest" | project TimeGenerated, Log_s | order by TimeGenerated desc | take 50`.'),
        timespan: z
          .string()
          .optional()
          .describe('ISO-8601 duration or interval bounding the query (default P1D = last 24h). e.g. PT6H, P7D.'),
        workspace_id: z
          .string()
          .optional()
          .describe('Log Analytics workspace customerId (default log-otchealth-shared). The identity can only read the shared workspace.'),
        max_rows: z.number().int().min(1).max(500).optional().describe('Cap rows returned (default 100).'),
      },
      outputShape: { columns: z.array(z.string()), rows: z.array(z.unknown()), rowCount: z.number() },
      handler: async (input) => {
        // RETIRED (see src/azure/retired.ts). Fails immediately -- before input handling,
        // before the dry-run branch, before any auth or network attempt -- with a named,
        // actionable error rather than a vague auth failure or a plausible dry-run plan.
        assertAzureToolLive('azure_logs_query');
        const { logAnalyticsWorkspaceId } = azureConfig();
        const ws = input.workspace_id || logAnalyticsWorkspaceId;
        const timespan = input.timespan || 'P1D';
        const maxRows = input.max_rows ?? 100;
        const out = await logAnalyticsQuery(ws, input.kql, timespan);
        const rows = out.rows.slice(0, maxRows);
        return {
          data: { columns: out.columns, rows, rowCount: rows.length, truncated: out.rowCount > rows.length },
          summary: `KQL returned ${out.rowCount} row(s)${out.rowCount > rows.length ? ` (showing ${rows.length})` : ''} over ${timespan}.`,
        };
      },
    },
    callerHash,
  );
}

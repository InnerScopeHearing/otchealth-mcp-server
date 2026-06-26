import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listUsageRecords } from '../../twilio/full-client.js';

export function registerTwilioUsageRecordsList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_usage_records_list',
    category: 'read',
    annotations: {
      title: 'List Twilio usage records',
      description: 'Lists account usage records (calls, SMS, cost summaries) via GET /Accounts/{SID}/Usage/Records.json with optional category and date filters. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      category: z.string().optional().describe('Usage category, e.g. "calls", "sms", "totalprice". See Twilio docs for full list.'),
      start_date: z.string().optional().describe('Start date for usage period (YYYY-MM-DD).'),
      end_date: z.string().optional().describe('End date for usage period (YYYY-MM-DD).'),
      page_size: z.number().int().min(1).max(100).optional().describe('Number of results (default 50, max 100).'),
    },
    outputShape: {
      usage_records: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const records = await listUsageRecords(input);
      return {
        data: { usage_records: records, count: records.length },
        summary: `Found ${records.length} usage record(s).`,
      };
    },
  }, callerHash);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listAvailablePhoneNumbers } from '../../twilio/full-client.js';

export function registerTwilioNumberListAvailable(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_number_list_available',
    category: 'read',
    annotations: {
      title: 'List available Twilio phone numbers for purchase',
      description: 'Searches Twilio\'s inventory of purchasable numbers via GET /Accounts/{SID}/AvailablePhoneNumbers/{CountryCode}/{Type}.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      country_code: z.string().length(2).describe('ISO 3166-1 alpha-2 country code (e.g. "US", "GB").'),
      type: z.enum(['Local', 'TollFree', 'Mobile']).optional().describe('Number type (default Local).'),
      area_code: z.string().optional().describe('Filter by 3-digit US/CA area code.'),
      contains: z.string().optional().describe('Pattern search (e.g. "800" or "***-555-****").'),
      page_size: z.number().int().min(1).max(30).optional().describe('Number of results (default 20, max 30).'),
    },
    outputShape: {
      available_numbers: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const numbers = await listAvailablePhoneNumbers(input);
      return {
        data: { available_numbers: numbers, count: numbers.length },
        summary: `Found ${numbers.length} available ${input.type ?? 'Local'} number(s) in ${input.country_code}.`,
      };
    },
  }, callerHash);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getOrgTagValues } from '../../sentry/full-client.js';

export function registerSentryTagGetValues(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_tag_get_values',
    category: 'read',
    annotations: {
      title: 'Get org-level tag values (Sentry)',
      description: 'Return observed values for a tag key at the org level.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      key: z.string().min(1).describe('Tag key, e.g. "environment", "release", "browser".'),
    },
    outputShape: { values: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const values = await getOrgTagValues(input.key);
      return { data: { values, count: values.length }, summary: `${values.length} value(s) for tag "${input.key}".` };
    },
  }, callerHash);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcSubmitEvent } from '../../intercom/full-client.js';

export function registerIntercomEventSubmit(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_event_submit',
    category: 'write_simple',
    annotations: {
      title: 'Submit a data event to Intercom',
      description: 'Submit a data event for a contact via POST /events. Identify the contact by user_id, email, or id. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      event_name: z.string().describe('Name of the event (e.g. "purchased-plan", "completed-onboarding").'),
      created_at: z.number().int().describe('Unix timestamp (seconds) when the event occurred.'),
      user_id: z.string().optional().describe('Your external user ID for the contact.'),
      email: z.string().email().optional().describe('Contact email address.'),
      id: z.string().optional().describe('Intercom contact ID.'),
      metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Event metadata key-value pairs.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      event_name: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, event_name: input.event_name },
          audit: { before: null, after: input },
          summary: `DRY RUN: would submit event "${input.event_name}" at timestamp ${input.created_at}. Pass dry_run=false to apply.`,
        };
      }
      await fcSubmitEvent(input);
      return {
        data: { executed: true, dry_run: false, event_name: input.event_name },
        audit: { before: null, after: input },
        summary: `Event "${input.event_name}" submitted successfully.`,
      };
    },
  }, callerHash);
}

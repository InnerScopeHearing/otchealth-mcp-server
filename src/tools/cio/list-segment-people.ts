import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appApiGet } from '../../customerio/app-api-client.js';

interface MembershipResponse {
  identifiers?: Array<Record<string, unknown>>;
  ids?: string[];
  next?: string | null;
}

export function registerListSegmentPeople(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'cio_list_segment_people',
      category: 'read',
      annotations: {
        title: 'List people in a Customer.io segment',
        description:
          'Paginated list of people who belong to the given segment. Returns identifiers (cio_id, email when exposed) and a next cursor.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        segment_id: z.union([z.string(), z.number()]),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().optional(),
      },
      outputShape: {
        people: z.array(z.unknown()),
        next_cursor: z.string().nullable(),
        count: z.number(),
      },
      handler: async (input, ctx) => {
        const id = encodeURIComponent(String(input.segment_id));
        const query: Record<string, string | number | undefined> = {};
        if (input.limit !== undefined) query.limit = input.limit;
        if (input.cursor !== undefined) query.start = input.cursor;
        const data = await appApiGet<MembershipResponse>(`/segments/${id}/membership`, {
          query,
          correlationId: ctx.correlationId,
        });
        const people = data.identifiers ?? (data.ids ?? []).map((cio_id) => ({ cio_id }));
        return {
          data: {
            people,
            next_cursor: data.next ?? null,
            count: people.length,
          },
          summary: `Found ${people.length} people in segment ${input.segment_id}.`,
        };
      },
    },
    callerHash,
  );
}

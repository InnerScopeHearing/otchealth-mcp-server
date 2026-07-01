import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSessionRecordings } from '../../posthog/full-client.js';

export function registerPostHogSessionRecordingList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_session_recording_list',
    category: 'read',
    annotations: {
      title: 'List PostHog session recordings',
      description: 'List session recordings for a PostHog project (GET /api/projects/{id}/session_recordings/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      limit: z.number().int().positive().optional().describe('Max results to return.'),
      offset: z.number().int().min(0).optional().describe('Pagination offset.'),
      person_uuid: z.string().optional().describe('Filter recordings by person UUID.'),
      date_from: z.string().optional().describe('ISO 8601 start date filter.'),
      date_to: z.string().optional().describe('ISO 8601 end date filter.'),
    },
    outputShape: {
      results: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const data = await listSessionRecordings({
        project_id: input.project_id,
        limit: input.limit,
        offset: input.offset,
        person_uuid: input.person_uuid,
        date_from: input.date_from,
        date_to: input.date_to,
      });
      const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
      return {
        data: { results, count: data?.count ?? results.length },
        summary: `${results.length} session recording(s) on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}

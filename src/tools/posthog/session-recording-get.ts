import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSessionRecording } from '../../posthog/full-client.js';

export function registerPostHogSessionRecordingGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'posthog_session_recording_get',
    category: 'read',
    annotations: {
      title: 'Get PostHog session recording',
      description: 'Retrieve metadata for a single session recording (GET /api/projects/{id}/session_recordings/{recording_id}/). MedReview PHI project 468398 is blocked.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('PostHog numeric project ID. Project 468398 (MedReview PHI) is blocked.'),
      recording_id: z.string().min(1).describe('Session recording ID.'),
    },
    outputShape: {
      recording: z.unknown(),
    },
    handler: async (input) => {
      const recording = await getSessionRecording({ project_id: input.project_id, recording_id: input.recording_id });
      return {
        data: { recording },
        summary: `Session recording ${input.recording_id} on project ${input.project_id}.`,
      };
    },
  }, callerHash);
}

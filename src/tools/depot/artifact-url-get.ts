import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getArtifactDownloadUrl } from '../../depot/full-client.js';

export function registerDepotArtifactUrlGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_artifact_url_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get artifact download URL',
      description: 'Get a short-lived (5-minute) signed HTTPS download URL for a Depot CI artifact. Use depot_artifacts_list to find artifact IDs. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      artifact_id: z.string().describe('The artifact ID (from depot_artifacts_list).'),
    },
    outputShape: {
      download_url: z.string().optional(),
      expires_note: z.string().optional(),
    },
    handler: async (input) => {
      const result = await getArtifactDownloadUrl({ artifactId: input.artifact_id });
      return {
        data: {
          download_url: result?.downloadUrl ?? result?.url,
          expires_note: 'URL expires 5 minutes after issuance.',
        },
        summary: `Download URL generated for artifact ${input.artifact_id}.`,
      };
    },
  }, callerHash);
}

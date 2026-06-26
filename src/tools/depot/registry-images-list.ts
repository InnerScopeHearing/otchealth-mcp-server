import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listRegistryImages } from '../../depot/full-client.js';

export function registerDepotRegistryImagesList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_registry_images_list',
    category: 'read',
    annotations: {
      title: 'Depot: list registry images',
      description: 'List container images stored in the Depot Registry for a project. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('The Depot project ID whose registry to list.'),
    },
    outputShape: {
      images: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const result = await listRegistryImages({ projectId: input.project_id });
      const images = result?.images ?? [];
      return {
        data: { images, count: images.length },
        summary: `${images.length} image(s) in Depot Registry for project ${input.project_id}.`,
      };
    },
  }, callerHash);
}

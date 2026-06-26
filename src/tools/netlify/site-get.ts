import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSite } from '../../netlify/full-client.js';

export function registerNetlifySiteGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_site_get',
    category: 'read',
    annotations: {
      title: 'Netlify: get site details',
      description: 'Fetch full details for a single Netlify site by ID (GET /sites/{site_id}). Returns name, URL, repo config, build settings, DNS, SSL state.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID (UUID). Use netlify_list_sites to find it.'),
    },
    outputShape: {
      id: z.string(),
      name: z.string(),
      url: z.string(),
      ssl_url: z.string().nullable(),
      custom_domain: z.string().nullable(),
      state: z.string().nullable(),
      created_at: z.string().nullable(),
      updated_at: z.string().nullable(),
      published_deploy_id: z.string().nullable(),
      build_settings: z.record(z.unknown()).nullable(),
      managed_dns: z.boolean().nullable(),
    },
    handler: async (input, _ctx) => {
      const s = await getSite(input.site_id);
      return {
        data: {
          id: s.id ?? '',
          name: s.name ?? '',
          url: s.url ?? s.ssl_url ?? '',
          ssl_url: s.ssl_url ?? null,
          custom_domain: s.custom_domain ?? null,
          state: s.state ?? null,
          created_at: s.created_at ?? null,
          updated_at: s.updated_at ?? null,
          published_deploy_id: s.published_deploy?.id ?? null,
          build_settings: s.build_settings ?? null,
          managed_dns: s.managed_dns ?? null,
        },
        summary: `Site ${s.name} (${s.id}): ${s.url ?? ''} — state: ${s.state ?? 'unknown'}.`,
      };
    },
  }, callerHash);
}

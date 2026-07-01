import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateSite } from '../../netlify/full-client.js';

export function registerNetlifySiteUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_site_update',
    category: 'write_simple',
    annotations: {
      title: 'Netlify: update site settings',
      description: 'Update Netlify site settings via PATCH /sites/{site_id}. Change name, custom domain, SSL, build settings. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID to update.'),
      name: z.string().optional().describe('New subdomain name.'),
      custom_domain: z.string().optional().describe('New custom domain (e.g. "app.example.com"). Empty string removes it.'),
      force_ssl: z.boolean().optional().describe('Enforce HTTPS redirects.'),
      prerender: z.string().optional().describe('Prerender service: "netlify" or custom URL.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      id: z.string().optional(),
      name: z.string().optional(),
      custom_domain: z.string().nullable().optional(),
    },
    handler: async (input, ctx) => {
      const { site_id, ...patch } = input;
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would PATCH site ${site_id} with ${JSON.stringify(patch)}. Pass dry_run=false to apply.`,
        };
      }
      const site = await updateSite(site_id, patch);
      return {
        data: { executed: true, dry_run: false, id: site.id, name: site.name, custom_domain: site.custom_domain ?? null },
        audit: { before: null, after: site },
        summary: `Updated site ${site.id} ("${site.name}").`,
      };
    },
  }, callerHash);
}

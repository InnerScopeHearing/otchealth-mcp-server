import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateZoneSetting } from '../../cloudflare/full-client.js';

export function registerCloudflareZoneUpdateSetting(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_zone_update_setting',
    category: 'write_simple',
    annotations: {
      title: 'Update zone setting',
      description: 'Update a single zone setting (e.g. ssl, security_level, cache_level). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      setting_id: z.string().describe('Setting identifier, e.g. "ssl", "security_level", "cache_level", "minify".'),
      value: z.unknown().describe('New value for the setting. Shape varies by setting.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      setting: z.unknown(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, setting: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update zone setting "${input.setting_id}" to ${JSON.stringify(input.value)}. Pass dry_run=false to apply.`,
        };
      }
      const setting = await updateZoneSetting(input.setting_id, input.value, input.zone_id);
      return {
        data: { executed: true, dry_run: false, setting },
        audit: { before: null, after: input },
        summary: `Updated zone setting "${input.setting_id}".`,
      };
    },
  }, callerHash);
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createRateLimitRule } from '../../cloudflare/full-client.js';

export function registerCloudflareRateLimitRuleCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_rate_limit_rule_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create rate-limit rule',
      description: 'Create a new rate-limiting rule using Cloudflare Ruleset Engine. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      expression: z.string().describe('Filter expression scoping which requests are counted.'),
      action: z.enum(['block', 'challenge', 'js_challenge', 'managed_challenge', 'log']).describe('Action when rate limit is exceeded.'),
      period: z.number().int().min(10).describe('Counting period in seconds (e.g. 60).'),
      requests_per_period: z.number().int().min(1).describe('Max requests allowed within the period before action triggers.'),
      description: z.string().describe('Human-readable name for the rule.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      rule: z.unknown(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, rule: null },
          audit: { before: null, after: { expression: input.expression, action: input.action, period: input.period, requests_per_period: input.requests_per_period } },
          summary: `DRY RUN: would create rate-limit rule [${input.action}] at ${input.requests_per_period} req/${input.period}s. Pass dry_run=false to apply.`,
        };
      }
      const rule = await createRateLimitRule(input.expression, input.action, input.period, input.requests_per_period, input.description, input.zone_id);
      return {
        data: { executed: true, dry_run: false, rule },
        audit: { before: null, after: input },
        summary: `Created rate-limit rule: ${input.description}.`,
      };
    },
  }, callerHash);
}

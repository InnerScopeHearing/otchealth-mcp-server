import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { setEnvVar } from '../../netlify/write-client.js';

/**
 * netlify_set_env_var — create or update a Netlify environment variable.
 * write_simple (env-var mutation; reversible). CTO-gated via governance; honors dry_run.
 */
export function registerNetlifySetEnvVar(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'netlify_set_env_var',
      category: 'write_simple',
      annotations: {
        title: 'Netlify: set environment variable',
        description:
          'Create or update a Netlify environment variable for an account (scoped to a site if site_id is provided). Uses POST /api/v1/accounts/{account_id}/env. Available contexts: all, dev, branch-deploy, deploy-preview, production. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        account_id: z
          .string()
          .min(1)
          .describe('Netlify account ID or slug (team slug visible in the Netlify dashboard URL).'),
        key: z
          .string()
          .min(1)
          .regex(/^[A-Z_][A-Z0-9_]*$/, 'Environment variable keys must be UPPER_SNAKE_CASE.')
          .describe('Environment variable name (e.g. "API_URL"). Must be UPPER_SNAKE_CASE.'),
        value: z.string().describe('Environment variable value.'),
        context: z
          .enum(['all', 'dev', 'branch-deploy', 'deploy-preview', 'production'])
          .optional()
          .default('all')
          .describe('Deploy context this value applies to. Default: "all".'),
        scopes: z
          .array(z.enum(['builds', 'functions', 'runtime', 'post-processing']))
          .optional()
          .describe('Build scopes. Default: all four scopes.'),
        site_id: z
          .string()
          .optional()
          .describe('Scope this env var to a specific site. Omit for account-wide scope.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        key: z.string().optional(),
        context: z.string().optional(),
        scopes: z.array(z.string()).optional(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, key: input.key, context: input.context },
            audit: { before: null, after: { key: input.key, context: input.context, site_id: input.site_id } },
            summary: `DRY RUN: would set env var "${input.key}" (context: ${input.context ?? 'all'}) on Netlify account ${input.account_id}. Pass dry_run=false to execute.`,
          };
        }
        const r = await setEnvVar({
          accountId: input.account_id,
          key: input.key,
          value: input.value,
          context: input.context,
          scopes: input.scopes,
          siteId: input.site_id,
        });
        return {
          data: { executed: true, dry_run: false, key: r.key, context: r.context, scopes: r.scopes },
          audit: { before: null, after: r },
          summary: `Set env var "${r.key}" (context: ${r.context}) on Netlify account ${input.account_id}.`,
        };
      },
    },
    callerHash,
  );
}

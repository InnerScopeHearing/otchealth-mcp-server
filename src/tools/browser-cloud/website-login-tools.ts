import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS } from './service.js';
import { currentIntercomPrincipalKey } from './intercom-login-service.js';
import type { WebsiteLoginService } from './website-login-service.js';
import { resolveWebsiteLoginTarget } from './website-login-policy.js';

const eligible = new Set<string>(CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS);
const inputShape = {
  site: z.enum(['wefunder', 'linkedin', 'custom']),
  url: z.string().url().max(2048).optional(),
  allowed_hosts: z.array(z.string().min(1).max(253)).min(1).max(24).optional(),
};
const outputShape = {
  login_url: z.string().optional(), profile_id: z.string().optional(), session_id: z.string().optional(),
  expires_at: z.number().optional(), status: z.string().optional(), persistent: z.boolean().optional(),
  allowed_hosts: z.array(z.string()).optional(), dry_run: z.boolean().optional(), error: z.string().optional(),
};

/** Human sign-in uses an isolated, connection-bound browser; MCP never handles credentials. */
export function registerWebsiteBrowserLoginTools(server: McpServer, callerHash: CallerHashProvider, runtime: () => WebsiteLoginService): void {
  for (const operation of ['start', 'profile_discover'] as const) {
    registerTool(server, {
      name: `browser_cloud_login_${operation}`, category: operation === 'start' ? 'write_simple' : 'read',
      annotations: {
        title: operation === 'start' ? 'Connect my website browser' : 'Find my saved website browser',
        description: operation === 'start'
          ? 'Open a short-lived human sign-in window for a public HTTPS website. Use WeFunder or LinkedIn presets, or site=custom with the expected signed-in page URL and optional additional exact hosts. Login state belongs only to this authenticated company connection. Sign in inside the window, confirm the intended account, and click Done. Keep the sign-in link out of shared memory. After saving, reopen the returned profile with browser_cloud_session_start and verify the signed-in page.'
          : 'Find this company connection’s own saved website browser profile. For a custom website, use the same expected signed-in URL and exact host list used for setup. Discovery creates no profile or browser session. Reopen and verify the intended signed-in account.',
        readOnlyHint: operation !== 'start', destructiveHint: false, idempotentHint: operation !== 'start', openWorldHint: true,
      },
      inputShape, outputShape,
      ephemeralOutput: operation === 'start',
      redactInputForLog: () => ({ operation, capability: 'website_login' }),
      shieldInputForScan: () => ({ operation, capability: 'website_login' }),
      redactResultForLog: () => ({ operation, capability: 'redacted' }),
      handler: async (input, ctx) => {
        if (!eligible.has(ctx.callerAgent)) return { data: { error: 'company_connection_required' }, summary: 'Use an eligible authenticated company connection.' };
        const key = currentIntercomPrincipalKey();
        if (!key) return { data: { error: 'oauth_connection_required' }, summary: 'This sign-in needs the company connection’s authenticated authorization binding.' };
        if (operation === 'start' && ctx.dryRun) return { data: { dry_run: true }, summary: 'No profile or sign-in session was created.' };
        try {
          if (input.site !== 'custom' && (input.url !== undefined || input.allowed_hosts !== undefined)) return { data: { error: 'invalid_website_target' }, summary: 'Use site=custom when supplying a website URL or host list.' };
          if (input.site === 'custom' && input.url === undefined) return { data: { error: 'invalid_website_target' }, summary: 'Supply the expected signed-in HTTPS page URL for this website.' };
          const target = input.site === 'custom' ? await resolveWebsiteLoginTarget({ url: input.url!, allowed_hosts: input.allowed_hosts }) : undefined;
          const result = operation === 'start'
            ? await runtime().start(ctx.callerAgent, key, input.site, target)
            : await runtime().discover(ctx.callerAgent, key, input.site, target);
          return { data: result, summary: operation === 'start' ? 'Open the sign-in link, complete login in its browser window, then click Done. Verify the saved profile in a new session.' : 'Owned profile found. Reopen it and verify the intended signed-in account.' };
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'website_login_unavailable';
          return { data: { error: code }, summary: `Website browser request did not complete: ${code}.` };
        }
      },
    }, callerHash);
  }
}

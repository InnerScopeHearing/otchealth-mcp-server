import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolResultPayload } from '../registry.js';
import { BROWSER_AGENTCORE_PROFILE_LABEL, isBrowserAgentcoreCallerAllowed } from './access.js';
import { MAX_SECONDS, MAX_TARGETS, ProfileLeaseStore, rejectSensitiveIntent, validatePublicTargets } from './policy.js';
import { AgentCoreBrowserTransportError, AwsAgentCorePublicReadOnlyTransport, agentCoreRuntimeConfig, assertAgentCoreConfigured, type AgentCoreBrowserTransport } from './transport.js';

const leases = new ProfileLeaseStore();
const PROVIDER = 'aws-agentcore-browser';
const ROLE = 'wefunder-campaign-director';
const defaultTransport = new AwsAgentCorePublicReadOnlyTransport();

function refusal(caller: string): ToolResultPayload {
  return { data: { error: 'forbidden_lane' }, summary: `Refused: browser_agentcore_wefunder tools are available only to Wefunder Campaign Director or CTO. Your identity: ${caller || '(none)'}.` };
}

function validated(input: { targets: string[]; intent: string }): { urls: URL[] } | ToolResultPayload {
  const denied = rejectSensitiveIntent(input);
  if (denied) return { data: { mode: 'refused', error: denied }, summary: `Refused: ${denied}. No browser session was created.` };
  const targets = validatePublicTargets(input.targets);
  if (!targets.ok) return { data: { mode: 'refused', error: targets.reason }, summary: `Refused: ${targets.reason}. No browser session was created.` };
  return { urls: targets.urls };
}

export function registerBrowserAgentcoreTools(server: McpServer, callerHash: CallerHashProvider, transport: AgentCoreBrowserTransport = defaultTransport): void {
  registerTool(server, {
    name: 'browser_agentcore_wefunder_preflight', category: 'read',
    annotations: { title: 'AgentCore Browser: Wefunder public-read-only preflight', description: 'Validates a bounded public-read-only Wefunder inspection. Creates no AWS resource, browser session, login, or profile state.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape: { targets: z.array(z.string()).min(1).max(MAX_TARGETS), intent: z.string().max(500).default('public read-only inspection') },
    outputShape: { ok: z.boolean(), mode: z.string(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isBrowserAgentcoreCallerAllowed(ctx.callerAgent)) return refusal(ctx.callerAgent);
      const result = validated(input);
      if (!('urls' in result)) return result;
      return { data: { ok: true, mode: 'public_read_only_preflight' }, summary: `Preflight passed for ${result.urls.length} public target(s). No browser session was created.` };
    },
  }, callerHash);

  registerTool(server, {
    name: 'browser_agentcore_wefunder_inspect_public', category: 'read',
    annotations: { title: 'AgentCore Browser: inspect Wefunder public pages', description: 'Feature-gated public-read-only inspection. No login, persistence, mutation, page body, screenshot, cookie, profile, session, stream, or credential material is returned.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: { targets: z.array(z.string()).min(1).max(MAX_TARGETS), intent: z.string().max(500).default('public read-only inspection'), max_seconds: z.number().int().min(1).max(MAX_SECONDS).optional() },
    outputShape: { mode: z.string(), receipts: z.array(z.unknown()).optional(), error: z.string().optional() },
    handler: async (input, ctx) => {
      if (!isBrowserAgentcoreCallerAllowed(ctx.callerAgent)) return refusal(ctx.callerAgent);
      const result = validated(input);
      if (!('urls' in result)) return result;
      const runtime = agentCoreRuntimeConfig();
      try { assertAgentCoreConfigured(runtime); } catch (error) {
        const e = error as AgentCoreBrowserTransportError;
        return { data: { mode: e.code, error: e.code }, summary: `${e.message} ${e.nextStep}` };
      }
      if (!leases.acquire(PROVIDER, ROLE, BROWSER_AGENTCORE_PROFILE_LABEL)) {
        return { data: { mode: 'busy', error: 'profile_in_use' }, summary: 'Refused: the isolated Wefunder profile already has an active lease.' };
      }
      try {
        // Not a connector surface (see registry.connector-lanes.test.ts -- this tool family is
        // deliberately absent from every curated connector toolset), so it keeps its pre-existing
        // output shape unchanged; transport.inspect() now returns {receipts, partial,
        // skipped_targets} (FND-20260829-e454), this just unwraps the receipts it always returned.
        const inspected = await transport.inspect(result.urls, input.max_seconds ?? MAX_SECONDS);
        const receipts = inspected.receipts;
        return { data: { mode: 'public_read_only', receipts }, summary: `Completed ${receipts.length} redacted public receipt(s).` };
      } catch (error) {
        const e = error as AgentCoreBrowserTransportError;
        return { data: { mode: e.code || 'provider_error', error: e.code || 'provider_error' }, summary: `${e.message || 'Browser provider failed.'} ${e.nextStep || 'No browser state was retained.'}` };
      } finally {
        leases.release(PROVIDER, ROLE, BROWSER_AGENTCORE_PROFILE_LABEL);
      }
    },
  }, callerHash);
}

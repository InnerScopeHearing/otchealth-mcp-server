import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolResultPayload } from '../registry.js';
import { currentCallerAgent } from '../../server/request-context.js';
import { BROWSER_AGENTCORE_PROFILE_LABEL, isBrowserAgentcoreCallerAllowed } from './access.js';
import { MAX_SECONDS, MAX_TARGETS, ProfileLeaseStore, rejectSensitiveIntent, validatePublicTargets } from './policy.js';

const leases = new ProfileLeaseStore();
const PROVIDER = 'aws-agentcore-browser';
const ROLE = 'wefunder-campaign-director';

function refusal(caller: string): ToolResultPayload { return { data: { error: 'forbidden_lane' }, summary: `Refused: browser_agentcore_wefunder tools are available only to Wefunder Campaign Director or CTO. Your identity: ${caller || '(none)'}.` }; }
function enabled(): boolean { return process.env.ENABLE_AGENTCORE_WEFUNDER_PUBLIC_READONLY === 'true'; }

export function registerBrowserAgentcoreTools(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'browser_agentcore_wefunder_preflight', category: 'read',
    annotations: { title: 'AgentCore Browser: Wefunder public-read-only preflight', description: 'Validates a bounded public-read-only Wefunder inspection. Creates no AWS resource or browser session.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape: { targets: z.array(z.string()).min(1).max(MAX_TARGETS), intent: z.string().max(500).default('public read-only inspection') }, outputShape: { ok: z.boolean(), mode: z.string(), error: z.string().optional() },
    handler: async (input) => { const caller = currentCallerAgent(); if (!isBrowserAgentcoreCallerAllowed(caller)) return refusal(caller); const denied = rejectSensitiveIntent(input); const validated = validatePublicTargets(input.targets); if (denied || !validated.ok) return { data: { ok: false, mode: 'preflight', error: denied ?? validated.reason }, summary: `Refused: ${denied ?? validated.reason}. No browser session was created.` }; return { data: { ok: true, mode: 'public_read_only_preflight' }, summary: `Preflight passed for ${validated.urls.length} public target(s). No AWS resource or browser session was created.` }; },
  }, callerHash);

  registerTool(server, {
    name: 'browser_agentcore_wefunder_inspect_public', category: 'read',
    annotations: { title: 'AgentCore Browser: inspect Wefunder public pages', description: 'Feature-gated public-read-only inspection. No login, persistence, mutation, page body, screenshot, cookie, profile, session, stream, or credential material is returned.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: { targets: z.array(z.string()).min(1).max(MAX_TARGETS), intent: z.string().max(500).default('public read-only inspection'), max_seconds: z.number().int().min(1).max(MAX_SECONDS).optional() }, outputShape: { mode: z.string(), receipts: z.array(z.unknown()).optional(), error: z.string().optional() },
    handler: async (input) => { const caller = currentCallerAgent(); if (!isBrowserAgentcoreCallerAllowed(caller)) return refusal(caller); const denied = rejectSensitiveIntent(input); const validated = validatePublicTargets(input.targets); if (denied || !validated.ok) return { data: { mode: 'refused', error: denied ?? validated.reason }, summary: `Refused: ${denied ?? validated.reason}. No browser session was created.` }; if (!enabled()) return { data: { mode: 'disabled', error: 'provider_disabled' }, summary: 'AgentCore public-read-only provider is disabled. No browser session was created.' }; if (!leases.acquire(PROVIDER, ROLE, BROWSER_AGENTCORE_PROFILE_LABEL)) return { data: { mode: 'busy', error: 'profile_in_use' }, summary: 'Refused: the isolated Wefunder profile already has an active lease.' }; try { return { data: { mode: 'runtime_adapter_unconfigured', error: 'no_transport_adapter' }, summary: 'AgentCore policy passed, but no gateway transport adapter is configured. No browser session was created.' }; } finally { leases.release(PROVIDER, ROLE, BROWSER_AGENTCORE_PROFILE_LABEL); } },
  }, callerHash);
}

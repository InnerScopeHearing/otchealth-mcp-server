/**
 * Hyperagent broker — the tool surface.
 *
 * Every tool here is ring-gated by ring.ts. The gateway holds ONE account-wide Hyperagent credential
 * (see client.ts for why a per-agent credential is impossible), so these wrappers are the only thing
 * standing between a caller lane and every thread on the account. They are written accordingly.
 *
 * THE ORDERING RULE THAT MATTERS: for anything addressed by threadId rather than agentId, the thread
 * is fetched, its owning agent is resolved, the ring is checked, and ONLY THEN is content returned.
 * Never return-then-check. If the owning agent cannot be determined, the call is REFUSED — an
 * undeterminable owner is the one case where guessing has an unbounded downside.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { loadEnv } from '../../config/env.js';
import { callHyperagentTool, hyperagentConfigured } from './client.js';
import {
  isHyperagentAgentAllowed,
  parseAgentClassMap,
  parseLaneAgentMap,
  visibleAgentsFor,
  type HyperagentClass,
} from './ring.js';

/** Config is parsed per call rather than cached, so a map change takes effect without a restart. */
function maps(): { laneMap: Record<string, string[]>; classMap: Record<string, HyperagentClass> } {
  return {
    laneMap: parseLaneAgentMap(loadEnv().HYPERAGENT_LANE_AGENTS),
    classMap: parseAgentClassMap(loadEnv().HYPERAGENT_AGENT_CLASSES),
  };
}

function unconfigured(summaryNoun: string) {
  return {
    data: { ok: false, mode: 'unconfigured' as const, error: 'unconfigured' },
    summary:
      `Hyperagent broker is not configured, so ${summaryNoun} is unavailable. It needs a one-time ` +
      `browser consent captured as hyperagent-refresh-token (Hyperagent has no client_credentials ` +
      `grant, so a server cannot self-authenticate).`,
  };
}

/** Pull an agent list out of whatever shape the provider returned, without assuming one. */
function extractAgents(data: unknown): Array<{ id?: string; name?: string; description?: string }> {
  if (Array.isArray(data)) return data as Array<{ id?: string; name?: string }>;
  const o = data as { agents?: unknown } | null;
  if (o && Array.isArray(o.agents)) return o.agents as Array<{ id?: string; name?: string }>;
  return [];
}

/**
 * Resolve the agent that owns a thread. Tries the field names a thread payload plausibly uses, and
 * returns null when none is present rather than defaulting to anything.
 */
function ownerAgentIdOf(data: unknown): string | null {
  const t = data as Record<string, unknown> | null;
  if (!t) return null;
  const thread = (t.thread as Record<string, unknown> | undefined) ?? t;
  for (const key of ['agentId', 'agent_id', 'agentID']) {
    const v = thread[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const nested = thread.agent as Record<string, unknown> | undefined;
  if (nested && typeof nested.id === 'string' && nested.id.trim()) return nested.id.trim();
  return null;
}

export function registerHyperagentTools(server: McpServer, callerHash: CallerHashProvider): void {
  // ---------------------------------------------------------------- list_agents (read, filtered)
  registerTool(
    server,
    {
      name: 'hyperagent_list_agents',
      category: 'read',
      annotations: {
        title: 'List the Hyperagent agents THIS lane may address',
        description:
          'Lists Hyperagent agents, filtered to the ones your lane is explicitly assigned and permitted to reach. Hyperagent itself has no per-agent authorization (one consent grants the whole account), so this gateway supplies it. Agents outside your ring are omitted entirely, not just refused.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {},
      outputShape: {
        agents: z.array(z.unknown()),
        count: z.number(),
        total_upstream: z.number().optional(),
        error: z.string().optional(),
      },
      handler: async (_input, ctx) => {
        if (!hyperagentConfigured()) return unconfigured('listing agents');
        const caller = ctx.callerAgent || '';
        const res = await callHyperagentTool('list_agents', {});
        if (!res.ok) {
          return {
            data: { agents: [], count: 0, error: res.error ?? 'provider_error' },
            summary: `Hyperagent list_agents failed: ${res.error ?? 'provider error'}.`,
          };
        }
        const all = extractAgents(res.data);
        const { laneMap, classMap } = maps();
        const visible = visibleAgentsFor(caller, all, laneMap, classMap);
        return {
          data: {
            agents: visible,
            count: visible.length,
            total_upstream: all.length,
          },
          summary:
            `${visible.length} of ${all.length} Hyperagent agent(s) are addressable by lane "${caller || '(none)'}". ` +
            `The remainder are outside your ring or not assigned to your lane.`,
        };
      },
    },
    callerHash,
  );

  // ------------------------------------------------------------- create_thread (ring-gated write)
  registerTool(
    server,
    {
      name: 'hyperagent_create_thread',
      category: 'write_orchestrated',
      annotations: {
        title: 'Start a Hyperagent agent working (ring-gated)',
        description:
          'Starts a new thread on a Hyperagent agent your lane is permitted to address. Returns a threadId immediately; the agent runs in the background. Poll hyperagent_get_thread for progress and results.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agentId: z.string().min(1).describe('Hyperagent agent id, from hyperagent_list_agents.'),
        message: z.string().min(1).describe('The opening message / task for the agent.'),
      },
      outputShape: {
        threadId: z.string().optional(),
        ok: z.boolean(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!hyperagentConfigured()) return unconfigured('starting a thread');
        const caller = ctx.callerAgent || '';
        const { laneMap, classMap } = maps();
        const verdict = isHyperagentAgentAllowed(caller, { id: input.agentId }, laneMap, classMap);
        if (!verdict.allowed) {
          return {
            data: { ok: false, error: verdict.reason },
            summary: `Refused (${verdict.reason}): lane "${caller || '(none)'}" may not address agent "${input.agentId}" (classified ${verdict.cls}).`,
          };
        }
        const res = await callHyperagentTool('create_thread', { agentId: input.agentId, message: input.message });
        if (!res.ok) return { data: { ok: false, error: res.error ?? 'provider_error' }, summary: `create_thread failed: ${res.error}.` };
        const tid = (res.data as { threadId?: string } | null)?.threadId;
        return {
          data: { ok: true, threadId: tid },
          summary: tid ? `Started thread ${tid} on agent ${input.agentId}. Poll hyperagent_get_thread for results.` : 'Thread created.',
        };
      },
    },
    callerHash,
  );

  // ------------------------------------------------- get_thread (read; FETCH -> CHECK -> RETURN)
  registerTool(
    server,
    {
      name: 'hyperagent_get_thread',
      category: 'read',
      annotations: {
        title: 'Read a Hyperagent thread (ring-gated, fail-closed)',
        description:
          "Reads a thread's messages and whether it is still running. The thread's owning agent is resolved and ring-checked BEFORE any content is returned. If the owning agent cannot be determined, the call is refused rather than served.",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: { threadId: z.string().min(1).describe('Thread id from hyperagent_create_thread or hyperagent_list_threads.') },
      outputShape: {
        thread: z.unknown().optional(),
        ok: z.boolean(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!hyperagentConfigured()) return unconfigured('reading a thread');
        const caller = ctx.callerAgent || '';
        const res = await callHyperagentTool('get_thread', { threadId: input.threadId });
        if (!res.ok) return { data: { ok: false, error: res.error ?? 'provider_error' }, summary: `get_thread failed: ${res.error}.` };

        // The payload is in this process now, but it has NOT been returned to the caller. The ring
        // check happens here, before any of it crosses back out.
        const ownerId = ownerAgentIdOf(res.data);
        if (!ownerId) {
          return {
            data: { ok: false, error: 'owner_agent_undeterminable' },
            summary:
              `Refused: could not determine which Hyperagent agent owns thread ${input.threadId}, so the ring ` +
              `cannot be checked. Refusing rather than serving content whose sensitivity is unknown.`,
          };
        }
        const { laneMap, classMap } = maps();
        const verdict = isHyperagentAgentAllowed(caller, { id: ownerId }, laneMap, classMap);
        if (!verdict.allowed) {
          return {
            data: { ok: false, error: verdict.reason },
            summary: `Refused (${verdict.reason}): thread ${input.threadId} belongs to agent "${ownerId}" (classified ${verdict.cls}), which lane "${caller || '(none)'}" may not read.`,
          };
        }
        return { data: { ok: true, thread: res.data }, summary: `Thread ${input.threadId} (agent ${ownerId}) returned to lane ${caller}.` };
      },
    },
    callerHash,
  );

  // ------------------------------------------------- send_message (ring-gated via owning agent)
  registerTool(
    server,
    {
      name: 'hyperagent_send_message',
      category: 'write_orchestrated',
      annotations: {
        title: 'Add a turn to a Hyperagent thread (ring-gated)',
        description:
          "Adds a follow-up turn to an existing thread. The thread's owning agent is resolved and ring-checked before the message is sent, so a lane cannot write into a thread it may not read.",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        threadId: z.string().min(1).describe('Thread to continue.'),
        message: z.string().min(1).describe('The follow-up message.'),
      },
      outputShape: { ok: z.boolean(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!hyperagentConfigured()) return unconfigured('sending a message');
        const caller = ctx.callerAgent || '';
        // Resolve ownership FIRST. Writing into a privileged thread is at least as bad as reading
        // one — it puts this lane's content into a thread whose readers it does not control.
        const probe = await callHyperagentTool('get_thread', { threadId: input.threadId });
        if (!probe.ok) return { data: { ok: false, error: probe.error ?? 'provider_error' }, summary: `Could not verify thread ownership: ${probe.error}.` };
        const ownerId = ownerAgentIdOf(probe.data);
        if (!ownerId) {
          return {
            data: { ok: false, error: 'owner_agent_undeterminable' },
            summary: `Refused: could not determine the owning agent for thread ${input.threadId}, so the ring cannot be checked.`,
          };
        }
        const { laneMap, classMap } = maps();
        const verdict = isHyperagentAgentAllowed(caller, { id: ownerId }, laneMap, classMap);
        if (!verdict.allowed) {
          return {
            data: { ok: false, error: verdict.reason },
            summary: `Refused (${verdict.reason}): thread ${input.threadId} belongs to agent "${ownerId}" (classified ${verdict.cls}); lane "${caller || '(none)'}" may not write to it.`,
          };
        }
        const res = await callHyperagentTool('send_message', { threadId: input.threadId, message: input.message });
        if (!res.ok) return { data: { ok: false, error: res.error ?? 'provider_error' }, summary: `send_message failed: ${res.error}.` };
        return { data: { ok: true }, summary: `Message added to thread ${input.threadId} (agent ${ownerId}).` };
      },
    },
    callerHash,
  );

  // ------------------------------------------------------------- list_threads (read, filtered)
  registerTool(
    server,
    {
      name: 'hyperagent_list_threads',
      category: 'read',
      annotations: {
        title: 'List Hyperagent threads THIS lane may see',
        description:
          'Lists threads, filtered to those belonging to agents your lane is permitted to address. Threads whose owning agent cannot be determined are omitted rather than shown, so an unclassifiable thread never leaks its existence or title.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {},
      outputShape: {
        threads: z.array(z.unknown()),
        count: z.number(),
        total_upstream: z.number().optional(),
        omitted: z.number().optional(),
        error: z.string().optional(),
      },
      handler: async (_input, ctx) => {
        if (!hyperagentConfigured()) return unconfigured('listing threads');
        const caller = ctx.callerAgent || '';
        const res = await callHyperagentTool('list_threads', {});
        if (!res.ok) return { data: { threads: [], count: 0, error: res.error ?? 'provider_error' }, summary: `list_threads failed: ${res.error}.` };

        const raw = Array.isArray(res.data) ? res.data : ((res.data as { threads?: unknown[] } | null)?.threads ?? []);
        const { laneMap, classMap } = maps();
        const visible = (raw as unknown[]).filter((t) => {
          const ownerId = ownerAgentIdOf(t);
          if (!ownerId) return false; // undeterminable owner is omitted, never shown
          return isHyperagentAgentAllowed(caller, { id: ownerId }, laneMap, classMap).allowed;
        });
        return {
          data: {
            threads: visible,
            count: visible.length,
            total_upstream: (raw as unknown[]).length,
            omitted: (raw as unknown[]).length - visible.length,
          },
          summary: `${visible.length} of ${(raw as unknown[]).length} thread(s) visible to lane "${caller || '(none)'}".`,
        };
      },
    },
    callerHash,
  );
}

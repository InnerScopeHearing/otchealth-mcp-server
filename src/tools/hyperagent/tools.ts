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
import {
  callHyperagentTool,
  hyperagentConfigured,
  listHyperagentCapabilities,
  type McpCallResult,
} from './client.js';
import { checkInvocationBudget } from './rate-limit.js';
import { ownerAgentIdOf } from './thread-owner.js';
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

export interface HyperagentToolTransport {
  configured(): boolean;
  call(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** Fixed upstream tools/list call. No caller-supplied RPC method is ever accepted. */
  listCapabilities?(): Promise<McpCallResult>;
}

const DEFAULT_TRANSPORT: HyperagentToolTransport = {
  configured: hyperagentConfigured,
  call: callHyperagentTool,
  listCapabilities: listHyperagentCapabilities,
};

const MAX_CAPABILITY_TOOLS = 64;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_NODES = 512;
const DECLARED_PAGING_FIELD_NAMES = new Set(['cursor', 'after', 'before', 'page', 'offset', 'limit', 'pageSize', 'page_size']);

type SafeSchema = Record<string, unknown>;

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? value as Record<string, unknown> : null;
}

function safeStringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || item.length > 128)) return null;
  return [...value];
}

/**
 * Keep a compact, data-free JSON Schema subset. Unsupported composition, references, descriptions,
 * and unknown keys are refused instead of relaying arbitrary provider metadata to the caller.
 */
function sanitizeInputSchema(value: unknown, depth = 0, state = { nodes: 0 }): SafeSchema | null {
  if (depth > MAX_SCHEMA_DEPTH || ++state.nodes > MAX_SCHEMA_NODES) return null;
  const source = plainRecord(value);
  if (!source) return null;
  const allowed = new Set(['type', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']);
  if (Object.keys(source).some(key => !allowed.has(key))) return null;
  const type = source.type;
  if (typeof type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)) return null;
  const out: SafeSchema = { type };
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'] as const) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'number' || !Number.isFinite(source[key] as number)) return null;
      out[key] = source[key];
    }
  }
  if (source.enum !== undefined) {
    if (!Array.isArray(source.enum) || source.enum.length > 64 || source.enum.some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item))) return null;
    out.enum = [...source.enum];
  }
  if (type === 'object') {
    if (source.properties !== undefined) {
      const properties = plainRecord(source.properties);
      if (!properties || Object.keys(properties).length > 64) return null;
      const clean: Record<string, SafeSchema> = {};
      for (const [name, schema] of Object.entries(properties)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) return null;
        const nested = sanitizeInputSchema(schema, depth + 1, state);
        if (!nested) return null;
        clean[name] = nested;
      }
      out.properties = clean;
    }
    if (source.required !== undefined) {
      const required = safeStringArray(source.required, 64);
      if (!required) return null;
      out.required = required;
    }
    if (source.additionalProperties !== undefined) {
      if (typeof source.additionalProperties !== 'boolean') return null;
      out.additionalProperties = source.additionalProperties;
    }
  }
  if (type === 'array' && source.items !== undefined) {
    const items = sanitizeInputSchema(source.items, depth + 1, state);
    if (!items) return null;
    out.items = items;
  }
  return out;
}

function declaredPagingMetadata(schema: SafeSchema): Array<{ name: string; type: string; required: boolean }> {
  if (schema.type !== 'object') return [];
  const properties = plainRecord(schema.properties) ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : []);
  return Object.entries(properties)
    .filter(([name]) => DECLARED_PAGING_FIELD_NAMES.has(name))
    .map(([name, child]) => ({ name, type: String(plainRecord(child)?.type ?? 'unknown'), required: required.has(name) }));
}

export function sanitizeHyperagentCapabilities(data: unknown):
  | { ok: true; tools: Array<{ name: string; inputSchema: SafeSchema; declaredPaging: Array<{ name: string; type: string; required: boolean }> }> }
  | { ok: false; error: 'unsafe_capabilities_metadata' } {
  const root = plainRecord(data);
  const tools = root?.tools;
  if (!Array.isArray(tools) || tools.length > MAX_CAPABILITY_TOOLS) return { ok: false, error: 'unsafe_capabilities_metadata' };
  const clean: Array<{ name: string; inputSchema: SafeSchema; declaredPaging: Array<{ name: string; type: string; required: boolean }> }> = [];
  for (const candidate of tools) {
    const tool = plainRecord(candidate);
    if (!tool || Object.keys(tool).some(key => !['name', 'inputSchema'].includes(key))) return { ok: false, error: 'unsafe_capabilities_metadata' };
    const name = tool.name;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(name)) return { ok: false, error: 'unsafe_capabilities_metadata' };
    const inputSchema = sanitizeInputSchema(tool.inputSchema);
    if (!inputSchema) return { ok: false, error: 'unsafe_capabilities_metadata' };
    clean.push({ name, inputSchema, declaredPaging: declaredPagingMetadata(inputSchema) });
  }
  return { ok: true, tools: clean };
}

/** Log/journal only routing metadata, never the investor-sensitive prompt sent to the source. */
export function hyperagentInvocationMetadata(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof input.agentId === 'string' ? { agentId: input.agentId } : {}),
    ...(typeof input.threadId === 'string' ? { threadId: input.threadId } : {}),
    message_chars: typeof input.message === 'string' ? input.message.length : 0,
  };
}

export function registerHyperagentTools(
  server: McpServer,
  callerHash: CallerHashProvider,
  transport: HyperagentToolTransport = DEFAULT_TRANSPORT,
): void {
  // ------------------------------------------------------- discover_capabilities (CTO metadata only)
  registerTool(
    server,
    {
      name: 'hyperagent_discover_capabilities',
      category: 'read',
      annotations: {
        title: 'Read the Hyperagent MCP tool schemas for migration planning',
        description:
          'CTO-only metadata discovery. Calls the fixed upstream MCP tools/list method and returns only validated tool names, compact input schemas, and declared paging field names. It never reads agents, threads, messages, files, or artifacts, and it accepts no upstream method or arguments from the caller.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {},
      outputShape: {
        ok: z.boolean(),
        tools: z.array(z.unknown()).optional(),
        error: z.string().optional(),
      },
      handler: async (_input, ctx) => {
        if (ctx.callerAgent !== 'cto') {
          return { data: { ok: false, error: 'forbidden_lane' }, summary: 'Refused: Hyperagent capability metadata is available only to the CTO lane.' };
        }
        if (!transport.configured()) return unconfigured('discovering provider capabilities');
        if (!transport.listCapabilities) {
          return { data: { ok: false, error: 'capability_transport_unavailable' }, summary: 'Hyperagent capability metadata transport is unavailable.' };
        }
        const result = await transport.listCapabilities();
        if (!result.ok) {
          return { data: { ok: false, error: 'provider_error' }, summary: 'Hyperagent capability metadata could not be read.' };
        }
        const safe = sanitizeHyperagentCapabilities(result.data);
        if (!safe.ok) {
          return { data: { ok: false, error: safe.error }, summary: 'Refused unsafe Hyperagent capability metadata.' };
        }
        return { data: { ok: true, tools: safe.tools }, summary: `Read ${safe.tools.length} validated Hyperagent tool schema(s) for migration planning.` };
      },
    },
    callerHash,
  );

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
        if (!transport.configured()) return unconfigured('listing agents');
        const caller = ctx.callerAgent || '';
        const res = await transport.call('list_agents', {});
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
      redactInputForLog: hyperagentInvocationMetadata,
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
        if (!transport.configured()) return unconfigured('starting a thread');
        const caller = ctx.callerAgent || '';
        const { laneMap, classMap } = maps();
        const verdict = isHyperagentAgentAllowed(caller, { id: input.agentId }, laneMap, classMap);
        if (!verdict.allowed) {
          return {
            data: { ok: false, error: verdict.reason },
            summary: `Refused (${verdict.reason}): lane "${caller || '(none)'}" may not address agent "${input.agentId}" (classified ${verdict.cls}).`,
          };
        }
        // AFTER the ring check, so a refused call never consumes budget, and BEFORE the provider
        // call, because the spend happens the moment the agent starts running.
        const budget = checkInvocationBudget(caller);
        if (!budget.allowed) {
          return {
            data: { ok: false, error: 'rate_limited' },
            summary:
              `Refused (rate_limited): lane "${caller || '(none)'}" has started ${budget.used} Hyperagent ` +
              `runs in the last hour (limit ${budget.limit}). Each run spends account credits, so this ` +
              `bounds a loop rather than throttling real work. Retry in ~${budget.retryAfterSeconds}s, ` +
              `or raise HYPERAGENT_MAX_INVOCATIONS_PER_HOUR.`,
          };
        }
        const res = await transport.call('create_thread', { agentId: input.agentId, message: input.message });
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
        if (!transport.configured()) return unconfigured('reading a thread');
        const caller = ctx.callerAgent || '';
        const res = await transport.call('get_thread', { threadId: input.threadId });
        if (!res.ok) return { data: { ok: false, error: res.error ?? 'provider_error' }, summary: `get_thread failed: ${res.error}.` };

        // The payload is in this process now, but it has NOT been returned to the caller. The ring
        // check happens here, before any of it crosses back out.
        const ownerId = ownerAgentIdOf(res.data, input.threadId);
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
      redactInputForLog: hyperagentInvocationMetadata,
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
        if (!transport.configured()) return unconfigured('sending a message');
        const caller = ctx.callerAgent || '';
        // Resolve ownership FIRST. Writing into a privileged thread is at least as bad as reading
        // one — it puts this lane's content into a thread whose readers it does not control.
        const probe = await transport.call('get_thread', { threadId: input.threadId });
        if (!probe.ok) return { data: { ok: false, error: probe.error ?? 'provider_error' }, summary: `Could not verify thread ownership: ${probe.error}.` };
        const ownerId = ownerAgentIdOf(probe.data, input.threadId);
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
        // Budgeted like create_thread: a follow-up message also makes the agent RUN, so it spends
        // exactly the same way a new thread does. Charged only after the ring check passes.
        const budget = checkInvocationBudget(caller);
        if (!budget.allowed) {
          return {
            data: { ok: false, error: 'rate_limited' },
            summary:
              `Refused (rate_limited): lane "${caller || '(none)'}" has triggered ${budget.used} Hyperagent ` +
              `runs in the last hour (limit ${budget.limit}). Retry in ~${budget.retryAfterSeconds}s, ` +
              `or raise HYPERAGENT_MAX_INVOCATIONS_PER_HOUR.`,
          };
        }
        const res = await transport.call('send_message', { threadId: input.threadId, message: input.message });
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
        if (!transport.configured()) return unconfigured('listing threads');
        const caller = ctx.callerAgent || '';
        const res = await transport.call('list_threads', {});
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

/**
 * Agent-inbox backend dispatcher.
 *
 * Every consumer of the inbox (agent_dispatch, inbox_read, wake) imports from HERE, never from
 * queue-azure.ts or queue-postgres.ts directly, so which store is live is decided in exactly one
 * place -- STATE_BACKEND, the SAME flag src/agentstate/store.ts already dispatches the document
 * store on. This module is queue.ts's counterpart to store.ts and deliberately mirrors its shape
 * (see that file's header for the full "why a dispatcher, not a shared base class" reasoning);
 * `activeBackend()` is imported from store.ts rather than re-read off loadEnv() here so the two
 * planes can never disagree about which backend is active.
 *
 * Before this file existed, the inbox had NO selector at all -- it called Azure Storage Queues
 * unconditionally, regardless of STATE_BACKEND. It was, along with cosmos.ts's document surface,
 * one of the last two hard Azure dependencies left on the request path; this closes the inbox's
 * half of that gap. If Azure disappears, agent-to-agent dispatch (agent_dispatch / inbox_read /
 * wake's inbox peek) now degrades exactly like the rest of the state plane: LOUDLY, by throwing,
 * once STATE_BACKEND=postgres is flipped -- never silently, and never by looking like an
 * inbox nobody wrote to. See queue-postgres.ts's header for the drain/peek/concurrency/TTL design
 * and the one flagged gap (no background expiry sweep yet).
 */

import { activeBackend } from './store.js';
import * as azure from './queue-azure.js';
import * as postgres from './queue-postgres.js';
import { queueName as sharedQueueName, type InboxMessage, type ReadMessage, type ReadMessagesOptions } from './queue-shared.js';

export type { InboxMessage, ReadMessage };

/** Pure, backend-independent: exposed here (as before this dispatcher existed) so existing
 *  callers/tests importing queueName from './queue.js' keep working unchanged. */
export function queueName(agent: string): string {
  return sharedQueueName(agent);
}

export function isConfigured(): boolean {
  return activeBackend() === 'postgres' ? postgres.isConfigured() : azure.isConfigured();
}

export async function ensureQueue(agent: string): Promise<void> {
  return activeBackend() === 'postgres' ? postgres.ensureQueue(agent) : azure.ensureQueue(agent);
}

export async function enqueue(agent: string, msg: InboxMessage, ttlSeconds = 604800): Promise<void> {
  return activeBackend() === 'postgres' ? postgres.enqueue(agent, msg, ttlSeconds) : azure.enqueue(agent, msg, ttlSeconds);
}

export async function readMessages(agent: string, opts: ReadMessagesOptions = {}): Promise<ReadMessage[]> {
  return activeBackend() === 'postgres' ? postgres.readMessages(agent, opts) : azure.readMessages(agent, opts);
}

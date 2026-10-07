/**
 * Backend-independent surface for the AGENT INBOX: the message shapes and the queue-name
 * normalization, shared by every backend adapter (queue-azure.ts, queue-postgres.ts) and by the
 * dispatcher (queue.ts) that switches between them on STATE_BACKEND.
 *
 * Deliberately dependency-free beyond ./agents.js: neither backend adapter may import the other,
 * or the generic document-store adapters (cosmos.ts / postgres.ts) -- see
 * agentstate-dependency-guard.test.ts, which forbids exactly that. This module is the one place
 * both are allowed to share code without creating that forbidden edge.
 */

import { normalizeAgent } from './agents.js';

export interface InboxMessage {
  to: string;
  from: string;
  subject: string;
  body: string;
  task_id?: string;
  ts: string;
}

export interface ReadMessage extends InboxMessage {
  message_id: string;
  dequeue_count: number;
  acked: boolean;
  /** Present only on dead-letter audit reads (ReadMessagesOptions.deadLetter); derived at read time. */
  dead_letter_reason?: 'expired' | 'max_deliveries';
}

/** A message older than this is dead-lettered even when its enqueue-time TTL is longer. */
export const INBOX_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** A message fetched more than this many times is treated as poison: dead-lettered, never redelivered. */
export const INBOX_MAX_DELIVERIES = 50;

/**
 * inbox-<agent>. Routes through normalizeAgent FIRST so the privilege wall (were one reinstated)
 * is enforced at every queue entry point, not just on the memory/ledger paths -- without this an
 * inbox-clo-personal queue could be created/read regardless of what the doc-store side allows.
 *
 * The result is also the value both backends bind as a SQL/SAS-signed parameter for "which
 * queue", so its charset (normalizeAgent's `^[a-z0-9][a-z0-9_-]{0,40}$`, then this function's own
 * `inbox-` prefix and `-`-collapsing) is the ONE place an untrusted agent id gets shaped before it
 * reaches either backend. Neither backend should re-derive or loosen this.
 */
export function queueName(agent: string): string {
  const a = normalizeAgent(agent);
  const name = `inbox-${a.replace(/_/g, '-')}`.replace(/-+/g, '-');
  return name;
}

export interface ReadMessagesOptions {
  max?: number;
  ack?: boolean;
  /** Azure-only: how long a peeked message stays hidden. The Postgres peek is side-effect free and ignores it. */
  visibilitySec?: number;
  /** AUDIT: return the dead-lettered messages (newest first). Read-only -- never drains, hides or counts a
   *  delivery. Postgres backend only (the dispatcher returns [] for any other backend). */
  deadLetter?: boolean;
  /** Overrides INBOX_MAX_AGE_SECONDS / INBOX_MAX_DELIVERIES. Test seams; production uses the defaults. */
  maxAgeSec?: number;
  maxDeliveries?: number;
}

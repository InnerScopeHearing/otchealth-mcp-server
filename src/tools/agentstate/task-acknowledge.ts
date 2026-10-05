import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { createDoc, isConfigured, readDoc } from '../../agentstate/store.js';
import { getTask } from '../../agentstate/ledger.js';
import { normalizeAgent } from '../../agentstate/agents.js';
import { canReadTaskDetails, taskVisibleToCaller } from './task-read-access.js';

type HandleKind = 'codex_session' | 'codex_thread' | 'device_session' | 'other';

export interface TaskAcknowledgeInput {
  task_id: string;
  board?: string;
  expected_lease_version: number;
  acknowledgement_key: string;
  receiver_handle_kind: HandleKind;
  receiver_declared_handle: string;
  evidence_sha256: string;
}

export interface TaskAcknowledgementRecord extends Record<string, unknown> {
  id: string;
  type: 'event';
  task_id: string;
  kind: 'receiver_acknowledged';
  actor: string;
  ts: string;
  request_sha256: string;
  acknowledgement_key_sha256: string;
  task_snapshot: {
    task_id: string;
    board: string;
    owner_agent: string;
    status: string;
    lease_version: number;
    lease_until: string;
    task_content_sha256: string;
    snapshot_sha256: string;
  };
  receiver_declared: {
    handle_kind: HandleKind;
    handle: string;
    handle_verification: 'caller_declared_not_runtime_attested';
    evidence_sha256: string;
    evidence_verification: 'caller_declared_digest_not_content_verified';
  };
  runtime_attested: {
    authenticated_lane: string;
    caller_credential_sha256: string;
    request_correlation_id: string;
    recorded_at_utc: string;
  };
  claims: {
    session_identity_verified: false;
    device_execution_proven: false;
    inbox_consumption_proven: false;
  };
}

export interface TaskAcknowledgeDependencies {
  isConfigured: typeof isConfigured;
  getTask: typeof getTask;
  createDoc: typeof createDoc;
  readDoc: typeof readDoc;
  taskVisibleToCaller: typeof taskVisibleToCaller;
  canReadTaskDetails: typeof canReadTaskDetails;
  now: () => Date;
}

const DEFAULT_DEPS: TaskAcknowledgeDependencies = {
  isConfigured,
  getTask,
  createDoc,
  readDoc,
  taskVisibleToCaller,
  canReadTaskDetails,
  now: () => new Date(),
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function ackId(taskId: string, board: string, lane: string, key: string): string {
  return `ack_${sha256(`${board}\u0000${taskId}\u0000${lane}\u0000${key}`).slice(0, 48)}`;
}

function recordMatches(
  value: Record<string, unknown>,
  expected: { id: string; taskId: string; actor: string; requestSha: string; keySha: string },
): value is TaskAcknowledgementRecord {
  return value.id === expected.id && value.task_id === expected.taskId && value.actor === expected.actor &&
    value.kind === 'receiver_acknowledged' && value.request_sha256 === expected.requestSha &&
    value.acknowledgement_key_sha256 === expected.keySha;
}

function notAcknowledged(reason: string): ToolResultPayload {
  return { data: { acknowledged: false, reason }, summary: `Task acknowledgement not recorded: ${reason}.` };
}

function safeHandle(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 200 || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  return trimmed;
}

async function isLeaseCurrentAtReadback(
  deps: TaskAcknowledgeDependencies,
  taskId: string,
  board: string,
  actor: string,
  leaseVersion: number,
): Promise<boolean> {
  const current = await deps.getTask(taskId, board);
  return Boolean(current && current.owner_agent.trim().toLowerCase() === actor &&
    (current.status === 'claimed' || current.status === 'in_progress') &&
    current.lease_version === leaseVersion && current.lease_until && Date.parse(current.lease_until) > deps.now().getTime());
}

/**
 * Records what the authenticated task owner acknowledges, without changing task status or lease.
 * The caller-supplied session/device handle and evidence digest are explicitly unverified
 * declarations; only caller lane/hash, correlation, server time, and the exact task/lease snapshot
 * are runtime-attested. This deliberately cannot certify a named Codex conversation or device.
 */
export async function handleTaskAcknowledge(
  input: TaskAcknowledgeInput,
  ctx: ToolContext,
  deps: TaskAcknowledgeDependencies = DEFAULT_DEPS,
): Promise<ToolResultPayload> {
  if (!deps.isConfigured()) return notAcknowledged('agent-state store is not configured');

  let actor: string;
  try { actor = normalizeAgent(ctx.callerAgent); } catch { return notAcknowledged('authenticated receiver lane is unavailable'); }

  const key = input.acknowledgement_key.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) return notAcknowledged('acknowledgement_key must be 8-128 safe characters');
  const handle = safeHandle(input.receiver_declared_handle);
  if (!handle) return notAcknowledged('receiver_declared_handle must be 3-200 printable characters');
  const evidenceSha = input.evidence_sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(evidenceSha)) return notAcknowledged('evidence_sha256 must be a 64-character SHA-256 digest');
  if (!Number.isSafeInteger(input.expected_lease_version) || input.expected_lease_version < 1) {
    return notAcknowledged('expected_lease_version must be a positive integer');
  }

  const taskId = input.task_id.trim();
  if (!taskId) return notAcknowledged('task_id is required');
  const board = input.board?.trim().toLowerCase() || 'fleet';
  const id = ackId(taskId, board, actor, key);
  const requestIdentity = {
    task_id: taskId,
    board,
    authenticated_lane: actor,
    expected_lease_version: input.expected_lease_version,
    receiver_handle_kind: input.receiver_handle_kind,
    receiver_declared_handle: handle,
    evidence_sha256: evidenceSha,
  };
  const requestSha = sha256(canonicalJson(requestIdentity));
  const keySha = sha256(key);
  const expectedRecord = { id, taskId, actor, requestSha, keySha };

  const task = await deps.getTask(taskId, board);
  if (!task || !deps.taskVisibleToCaller(task, actor)) return notAcknowledged('task not found or unavailable to this lane');
  if (!deps.canReadTaskDetails(task, actor)) return notAcknowledged('task details are unavailable to this lane');
  if (task.owner_agent.trim().toLowerCase() !== actor) return notAcknowledged('only the authenticated current task owner lane may acknowledge');

  // Resolve an exact retry after current authorization. Idempotent replay remains readable after
  // lease expiry/reclaim, but not after ownership or detail access has changed.
  const prior = await deps.readDoc('events', taskId, id);
  if (prior) {
    const record = prior.doc as Record<string, unknown>;
    if (!recordMatches(record, expectedRecord)) {
      return notAcknowledged('idempotency key was already used with different acknowledgement content');
    }
    const typedRecord = record as unknown as TaskAcknowledgementRecord;
    const leaseCurrent = await isLeaseCurrentAtReadback(deps, taskId, board, actor, input.expected_lease_version);
    return {
      data: { acknowledged: true, replayed: true, readback_confirmed: true, lease_current_at_readback: leaseCurrent, record: typedRecord, claims: typedRecord.claims },
      summary: `Previously recorded acknowledgement ${typedRecord.id} was read back for ${taskId}.`,
    };
  }

  if (task.status !== 'claimed' && task.status !== 'in_progress') return notAcknowledged('task must have an active claimed or in-progress lease');
  if (task.lease_version !== input.expected_lease_version) return notAcknowledged('stale lease version');
  if (!task.lease_until || !Number.isFinite(Date.parse(task.lease_until)) || Date.parse(task.lease_until) <= deps.now().getTime()) {
    return notAcknowledged('task lease is absent or expired');
  }

  const contentSnapshot = {
    id: task.id,
    board: task.board,
    title: task.title,
    description: task.description,
    owner_agent: task.owner_agent,
    status: task.status,
    priority: task.priority,
    tags: task.tags,
    claim_ts: task.claim_ts,
    lease_until: task.lease_until,
    lease_version: task.lease_version,
  };
  const taskContentSha = sha256(canonicalJson(contentSnapshot));
  const snapshotBase = {
    task_id: task.id,
    board: task.board,
    owner_agent: task.owner_agent,
    status: task.status,
    lease_version: task.lease_version,
    lease_until: task.lease_until,
    task_content_sha256: taskContentSha,
  };
  const snapshotSha = sha256(canonicalJson(snapshotBase));
  const receivedAt = deps.now().toISOString();
  const record: TaskAcknowledgementRecord = {
    id,
    type: 'event',
    task_id: taskId,
    kind: 'receiver_acknowledged',
    actor,
    ts: receivedAt,
    request_sha256: requestSha,
    acknowledgement_key_sha256: keySha,
    task_snapshot: { ...snapshotBase, snapshot_sha256: snapshotSha },
    receiver_declared: {
      handle_kind: input.receiver_handle_kind,
      handle,
      handle_verification: 'caller_declared_not_runtime_attested',
      evidence_sha256: evidenceSha,
      evidence_verification: 'caller_declared_digest_not_content_verified',
    },
    runtime_attested: {
      authenticated_lane: actor,
      caller_credential_sha256: ctx.callerHash,
      request_correlation_id: ctx.correlationId,
      recorded_at_utc: receivedAt,
    },
    claims: { session_identity_verified: false, device_execution_proven: false, inbox_consumption_proven: false },
  };

  try {
    await deps.createDoc('events', taskId, record as unknown as Record<string, unknown>);
  } catch {
    // A create timeout/conflict has an unknown outcome. Only exact readback can turn it into success.
    const recovered = await deps.readDoc('events', taskId, id);
    if (!recovered) return notAcknowledged('acknowledgement write outcome is unknown; retry the same key after readback');
    const savedDoc = recovered.doc;
    if (!recordMatches(savedDoc, expectedRecord)) {
      return notAcknowledged('acknowledgement write collided with different content');
    }
    const saved = savedDoc as unknown as TaskAcknowledgementRecord;
    const leaseCurrent = await isLeaseCurrentAtReadback(deps, taskId, board, actor, input.expected_lease_version);
    return {
      data: { acknowledged: true, replayed: true, reconciled_after_uncertain_write: true, readback_confirmed: true, lease_current_at_readback: leaseCurrent, record: saved, claims: saved.claims },
      summary: `Acknowledgement ${saved.id} was recovered by exact readback.`,
    };
  }

  const readback = await deps.readDoc('events', taskId, id);
  if (!readback) return notAcknowledged('acknowledgement write was sent but exact readback is not yet available');
  const savedDoc = readback.doc;
  if (!recordMatches(savedDoc, expectedRecord)) {
    return notAcknowledged('acknowledgement readback did not match the requested content');
  }
  const saved = savedDoc as unknown as TaskAcknowledgementRecord;

  // A lease may change while the append-only acknowledgement is being written. Expose the final
  // fence read so callers can distinguish a durable acknowledgement of an old lease from a current one.
  const leaseCurrent = await isLeaseCurrentAtReadback(deps, taskId, board, actor, input.expected_lease_version);
  return {
    data: {
      acknowledged: true,
      replayed: false,
      readback_confirmed: true,
      lease_current_at_readback: leaseCurrent,
      record: saved,
      claims: saved.claims,
    },
    summary: `Durable acknowledgement ${saved.id} recorded for ${taskId} lease ${input.expected_lease_version}; session/device identity remains caller-declared.`,
  };
}

export function registerTaskAcknowledge(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'task_acknowledge',
    category: 'write_simple',
    annotations: {
      title: 'Record authenticated receiver acknowledgement for a task lease',
      description: 'Append a durable receiver acknowledgement only when the authenticated lane owns the exact active task lease. The task ID, lease version and task content hash are captured by the gateway. The receiver-declared session/device handle and evidence digest are not runtime-verified. This records what the authenticated lane declares; it does NOT prove a named chat session, device execution, inbox consumption or task completion. Read it back through task_get with include_events=true. Pass dry_run=false to persist.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputShape: {
      task_id: z.string().min(1).describe('Existing task ID; no task is created or changed.'),
      board: z.string().optional().describe('Board partition (default fleet).'),
      expected_lease_version: z.number().int().positive().describe('Exact lease fencing version read from the existing task.'),
      acknowledgement_key: z.string().min(8).max(128).describe('Caller-generated idempotency key; re-use only for exact retries.'),
      receiver_handle_kind: z.enum(['codex_session', 'codex_thread', 'device_session', 'other']),
      receiver_declared_handle: z.string().min(3).max(200).describe('Existing receiver handle as declared by the caller; the gateway cannot attest it identifies this MCP client.'),
      evidence_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).describe('Receiver-declared SHA-256 of non-sensitive evidence; the gateway validates format, not the source bytes.'),
    },
    outputShape: { acknowledged: z.boolean(), replayed: z.boolean().optional(), readback_confirmed: z.boolean().optional(), lease_current_at_readback: z.boolean().optional(), record: z.unknown().optional(), claims: z.unknown().optional(), reason: z.string().optional() },
    handler: async (input, ctx) => {
      const { dryRun, ...ackInput } = { ...input, dryRun: ctx.dryRun };
      if (dryRun) return {
        data: { acknowledged: false, preview: { ...ackInput, authenticated_lane: ctx.callerAgent }, note: 'dry_run: pass dry_run=false to persist; declared handle and digest are not verified.' },
        summary: `DRY RUN: would record a receiver acknowledgement for ${input.task_id}.`,
      };
      return handleTaskAcknowledge(input, ctx);
    },
  }, callerHash);
}

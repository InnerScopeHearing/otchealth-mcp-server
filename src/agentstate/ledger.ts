/**
 * The work-ledger: the single system-of-record for fleet work, on Cosmos DB.
 *
 * One document per task in the `tasks` container (partitioned on /board, default board "fleet",
 * so owner_agent is a MUTABLE field and claim/reassign never repartitions). Every state
 * transition is also appended to the `events` container (partitioned on /task_id) as an
 * immutable audit trail.
 *
 * The load-bearing rule lives in completeTask(): a task cannot reach `done` unless its
 * artifact_uri resolves (see resolver.ts). done = artifact landed, enforced here.
 */

import { createDoc, readDoc, replaceDoc, queryDocs, newId } from './cosmos.js';
import { resolveArtifact } from './resolver.js';
import { normalizeAgent, type TaskStatus } from './agents.js';

const TASKS = 'tasks';
const EVENTS = 'events';
export const DEFAULT_BOARD = 'fleet';
const LEASE_MINUTES = 45;

export interface Task {
  id: string;
  board: string;
  type: 'task';
  title: string;
  description: string;
  owner_agent: string;
  status: TaskStatus;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  tags: string[];
  artifact_uri: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  claim_ts: string | null;
  lease_until: string | null;
  done_ts: string | null;
  notes: string[];
}

async function appendEvent(taskId: string, kind: string, actor: string, detail: string): Promise<void> {
  const ev = {
    id: newId('e'),
    type: 'event',
    task_id: taskId,
    kind,
    actor,
    detail,
    ts: new Date().toISOString(),
  };
  try {
    await createDoc(EVENTS, taskId, ev);
  } catch {
    /* event log is best-effort; never fail the primary op on an event-write hiccup */
  }
}

export async function createTask(input: {
  title: string;
  description?: string;
  owner_agent: string;
  created_by: string;
  priority?: Task['priority'];
  tags?: string[];
  board?: string;
}): Promise<Task> {
  const owner = normalizeAgent(input.owner_agent);
  const board = (input.board || DEFAULT_BOARD).trim().toLowerCase();
  const now = new Date().toISOString();
  const task: Task = {
    id: newId('t'),
    board,
    type: 'task',
    title: input.title,
    description: input.description ?? '',
    owner_agent: owner,
    status: 'open',
    priority: input.priority ?? 'normal',
    tags: input.tags ?? [],
    artifact_uri: null,
    created_by: input.created_by,
    created_at: now,
    updated_at: now,
    claim_ts: null,
    lease_until: null,
    done_ts: null,
    notes: [],
  };
  await createDoc(TASKS, board, task as unknown as Record<string, unknown>);
  await appendEvent(task.id, 'created', input.created_by, `created for ${owner} (${task.priority})`);
  return task;
}

export async function getTask(id: string, board = DEFAULT_BOARD): Promise<Task | null> {
  const hit = await readDoc(TASKS, board, id);
  return hit ? (hit.doc as unknown as Task) : null;
}

/** Claim a task with a lease (optimistic concurrency; a lost race returns {conflict:true}). */
export async function claimTask(
  id: string,
  agent: string,
  board = DEFAULT_BOARD,
): Promise<{ task?: Task; conflict?: boolean; reason?: string }> {
  const who = normalizeAgent(agent);
  for (let attempt = 0; attempt < 2; attempt++) {
    const hit = await readDoc(TASKS, board, id);
    if (!hit) return { reason: 'not found' };
    const task = hit.doc as unknown as Task;
    if (task.status === 'done' || task.status === 'cancelled') {
      return { reason: `task already ${task.status}` };
    }
    const now = new Date();
    const leasedToOther =
      task.status === 'claimed' &&
      task.owner_agent !== who &&
      task.lease_until &&
      new Date(task.lease_until) > now;
    if (leasedToOther) {
      return { conflict: true, reason: `leased to ${task.owner_agent} until ${task.lease_until}` };
    }
    task.owner_agent = who;
    task.status = 'claimed';
    task.claim_ts = now.toISOString();
    task.lease_until = new Date(now.getTime() + LEASE_MINUTES * 60000).toISOString();
    task.updated_at = now.toISOString();
    const res = await replaceDoc(TASKS, board, id, task as unknown as Record<string, unknown>, hit.etag ?? undefined);
    if (res.status === 412) continue; // lost the race; re-read and retry
    if (!res.ok) return { reason: `claim failed: ${res.status}` };
    await appendEvent(id, 'claimed', who, `lease until ${task.lease_until}`);
    return { task };
  }
  return { conflict: true, reason: 'concurrent claim, please retry' };
}

export async function updateTask(
  id: string,
  patch: { status?: TaskStatus; note?: string; artifact_uri?: string; owner_agent?: string; priority?: Task['priority'] },
  actor: string,
  board = DEFAULT_BOARD,
): Promise<{ task?: Task; reason?: string }> {
  const hit = await readDoc(TASKS, board, id);
  if (!hit) return { reason: 'not found' };
  const task = hit.doc as unknown as Task;
  if (patch.status) task.status = patch.status;
  if (patch.priority) task.priority = patch.priority;
  if (patch.artifact_uri !== undefined) task.artifact_uri = patch.artifact_uri;
  if (patch.owner_agent) task.owner_agent = normalizeAgent(patch.owner_agent);
  if (patch.note) task.notes = [...(task.notes ?? []), `[${new Date().toISOString()}] ${actor}: ${patch.note}`];
  task.updated_at = new Date().toISOString();
  const res = await replaceDoc(TASKS, board, id, task as unknown as Record<string, unknown>, hit.etag ?? undefined);
  if (res.status === 412) return { reason: 'conflict, re-read and retry' };
  if (!res.ok) return { reason: `update failed: ${res.status}` };
  await appendEvent(id, 'updated', actor, JSON.stringify(patch).slice(0, 240));
  return { task };
}

/** Complete a task: REJECTS unless artifact_uri resolves. done = artifact landed. */
export async function completeTask(
  id: string,
  artifactUri: string,
  agent: string,
  note: string | undefined,
  board = DEFAULT_BOARD,
): Promise<{ task?: Task; rejected?: boolean; reason?: string; resolution?: unknown }> {
  const who = normalizeAgent(agent);
  const resolution = await resolveArtifact(artifactUri);
  if (!resolution.resolved) {
    await appendEvent(id, 'complete_rejected', who, `${artifactUri} :: ${resolution.detail}`);
    return {
      rejected: true,
      reason: `done = artifact landed. artifact_uri did not resolve (${resolution.scheme}: ${resolution.detail}). Land the work-product first (commons blob:, a resolvable URL, a cosmos: doc, or gh:).`,
      resolution,
    };
  }
  const hit = await readDoc(TASKS, board, id);
  if (!hit) return { reason: 'not found' };
  const task = hit.doc as unknown as Task;
  const now = new Date().toISOString();
  task.status = 'done';
  task.artifact_uri = artifactUri;
  task.done_ts = now;
  task.updated_at = now;
  if (note) task.notes = [...(task.notes ?? []), `[${now}] ${who} (done): ${note}`];
  const res = await replaceDoc(TASKS, board, id, task as unknown as Record<string, unknown>, hit.etag ?? undefined);
  if (res.status === 412) return { reason: 'conflict, re-read and retry' };
  if (!res.ok) return { reason: `complete failed: ${res.status}` };
  await appendEvent(id, 'completed', who, `artifact ${artifactUri} (${resolution.detail})`);
  return { task, resolution };
}

export async function listTasks(filter: {
  owner_agent?: string;
  status?: TaskStatus;
  board?: string;
  limit?: number;
}): Promise<Task[]> {
  const board = (filter.board || DEFAULT_BOARD).trim().toLowerCase();
  const conds: string[] = ['c.board = @board', "c.type = 'task'"];
  const params: { name: string; value: unknown }[] = [{ name: '@board', value: board }];
  if (filter.owner_agent) {
    conds.push('c.owner_agent = @owner');
    params.push({ name: '@owner', value: normalizeAgent(filter.owner_agent) });
  }
  if (filter.status) {
    conds.push('c.status = @status');
    params.push({ name: '@status', value: filter.status });
  }
  const query = `SELECT * FROM c WHERE ${conds.join(' AND ')} ORDER BY c.created_at DESC`;
  const rows = await queryDocs(TASKS, query, params, { pk: board, max: filter.limit ?? 50 });
  return rows as unknown as Task[];
}

export async function listEvents(taskId: string, limit = 50): Promise<Record<string, unknown>[]> {
  const query = 'SELECT * FROM c WHERE c.task_id = @tid ORDER BY c.ts ASC';
  return queryDocs(EVENTS, query, [{ name: '@tid', value: taskId }], { pk: taskId, max: limit });
}

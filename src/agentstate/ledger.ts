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
 *
 * FENCING (added 2026-07-05, P0-CLAIM-LEASE): claimTask/updateTask/completeTask already used
 * per-write ETag optimistic concurrency, which stops a literal simultaneous double-write, but did
 * NOT stop a "zombie worker" — a holder whose lease already expired and was reclaimed by someone
 * else could still call updateTask/completeTask and silently clobber the new holder's work, because
 * neither checked who currently holds the lease. `lease_version` is a monotonic fencing token:
 * claimTask increments it on every successful claim; callers that pass `expected_lease_version` to
 * updateTask/completeTask/heartbeatTask are rejected if it no longer matches (their lease was
 * reclaimed out from under them). Passing it is OPTIONAL so existing callers are unaffected; new/
 * careful callers get real protection. heartbeatTask is new: extends lease_until for a still-valid
 * holder so a long task doesn't get reclaimed mid-execution.
 *
 * DEAD-LETTER (A14-DEAD-LETTER):
 * `attempt_count` tracks how many times a task has been RECLAIMED (i.e. claimed after already
 * having a claim_ts from a previous claim) — NOT how many times it has been claimed in total, so a
 * clean "claim once, complete" task stays at attempt_count 0. It is distinct from lease_version
 * (a fencing token, unrelated semantics, untouched by this change). Once attempt_count reaches
 * MAX_CLAIM_ATTEMPTS, the NEXT claim attempt is redirected to a new terminal status, `dead_letter`,
 * instead of being granted — see claimTask. This is deliberately an inline check in claimTask, not
 * a periodic sweep: the decision needs only the one document claimTask already read (no fleet-wide
 * view required), and doing it inline means the very next actor to touch the task is the one who
 * observes and reacts to the terminal condition, with no cron lag. See the design doc for the
 * known gap this does NOT cover (a claimed task whose lease expires and that nobody ever tries to
 * claim again will not be swept into dead_letter by this alone).
 */

import { createDoc, readDoc, replaceDoc, queryDocs, newId } from './store.js';
import { resolveArtifact } from './resolver.js';
import { normalizeAgent, type TaskStatus } from './agents.js';

const TASKS = 'tasks';
const EVENTS = 'events';
export const DEFAULT_BOARD = 'fleet';
const LEASE_MINUTES = 45;

// A14-DEAD-LETTER: max number of RECLAIMS (not total claims) before a task is retired to
// `dead_letter` instead of being handed out again. 3 reclaims * LEASE_MINUTES(45) is up to ~2.25h of
// a task cycling claim->fail->expire->reclaim before anyone/anything is told it's stuck. Tunable;
// see design doc section 2 for the reasoning and the explicit "not fully confident" flag on this
// number — raise to 5 if real retry-success-rate data says tasks legitimately need more attempts.
export const MAX_CLAIM_ATTEMPTS = 3;

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
  lease_version: number;
  idempotency_key: string | null;
  done_ts: string | null;
  notes: string[];
  // A14-DEAD-LETTER: count of RECLAIMS (claims after a prior claim_ts already existed), not
  // total claims. 0 for a task that has only ever been claimed once (the common/happy path). See
  // claimTask for the precise increment rule.
  attempt_count: number;
}

/**
 * `claimedActor` (FND-20260829-878f): when the caller's tool input named a different identity than
 * their authenticated token (see tools/agentstate/attribution.ts's resolveAttribution -- the actor
 * param here is ALWAYS already the token-bound value, never the raw caller input), the mismatch is
 * recorded on the event as its own field AND appended to `detail`, so both a structured query
 * (`c.claimed_actor != null`) and a human skimming raw event text can see it. Never persisted onto
 * the Task document itself -- the events container is this module's own documented "immutable audit
 * trail" (see this file's header), which is exactly what "recorded for audit" calls for without
 * widening the Task schema every caller of task_get/task_list already reads.
 */
async function appendEvent(
  taskId: string,
  kind: string,
  actor: string,
  detail: string,
  claimedActor?: string,
): Promise<void> {
  const ev = {
    id: newId('e'),
    type: 'event',
    task_id: taskId,
    kind,
    actor,
    detail: claimedActor ? `${detail} (claimed actor: "${claimedActor}")` : detail,
    ...(claimedActor ? { claimed_actor: claimedActor } : {}),
    ts: new Date().toISOString(),
  };
  try {
    await createDoc(EVENTS, taskId, ev);
  } catch {
    /* event log is best-effort; never fail the primary op on an event-write hiccup */
  }
}

/** Deterministic id from an idempotency key, so retried creates with the SAME key never duplicate
 *  a task — the caller gets the original task back instead. Same charset the Cosmos client allows. */
function idFromIdempotencyKey(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `t_idem_${hex}`;
}

export async function createTask(input: {
  title: string;
  description?: string;
  owner_agent: string;
  created_by: string;
  priority?: Task['priority'];
  tags?: string[];
  board?: string;
  idempotency_key?: string;
  /** FND-20260829-878f: set by the tool layer only when the caller's claimed created_by differed
   *  from their authenticated token identity. `created_by` above is ALREADY the token-bound value
   *  by the time it reaches here -- this is audit-only, threaded to the 'created' event. */
  claimed_created_by?: string;
}): Promise<{ task: Task; deduped: boolean }> {
  const owner = normalizeAgent(input.owner_agent);
  const board = (input.board || DEFAULT_BOARD).trim().toLowerCase();

  // Idempotent create: if a task with this key already exists (on this board), return it as-is
  // instead of creating a duplicate. This is the "retried dispatch must not double-work" guard.
  if (input.idempotency_key) {
    const existingId = idFromIdempotencyKey(`${board}:${input.idempotency_key}`);
    const hit = await readDoc(TASKS, board, existingId);
    if (hit) return { task: hit.doc as unknown as Task, deduped: true };
  }

  const now = new Date().toISOString();
  const task: Task = {
    id: input.idempotency_key ? idFromIdempotencyKey(`${board}:${input.idempotency_key}`) : newId('t'),
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
    lease_version: 0,
    idempotency_key: input.idempotency_key ?? null,
    done_ts: null,
    notes: [],
    attempt_count: 0, // A14-DEAD-LETTER
  };
  try {
    await createDoc(TASKS, board, task as unknown as Record<string, unknown>);
  } catch (e) {
    // Race: two callers with the same idempotency_key created concurrently — the loser re-reads
    // and returns the winner's doc instead of erroring (still idempotent from the caller's view).
    if (input.idempotency_key) {
      const hit = await readDoc(TASKS, board, task.id);
      if (hit) return { task: hit.doc as unknown as Task, deduped: true };
    }
    throw e;
  }
  await appendEvent(task.id, 'created', input.created_by, `created for ${owner} (${task.priority})`, input.claimed_created_by);
  return { task, deduped: false };
}

export async function getTask(id: string, board = DEFAULT_BOARD): Promise<Task | null> {
  const hit = await readDoc(TASKS, board, id);
  return hit ? (hit.doc as unknown as Task) : null;
}

/**
 * Claim a task with a lease (optimistic concurrency; a lost race returns {conflict:true}).
 *
 * A14-DEAD-LETTER: if the task's attempt_count has already reached MAX_CLAIM_ATTEMPTS, this
 * claim is refused and the task is instead transitioned to the terminal `dead_letter` status (see
 * design doc for why this check lives here, inline, rather than in a periodic sweep). The caller
 * gets back `{ dead_lettered: true, task }` instead of a granted claim, so a tool handler (e.g.
 * task-claim.ts) can react — e.g. notify created_by/owner_agent via the agent inbox — without
 * ledger.ts itself depending on the queue/inbox subsystem.
 *
 * attempt_count is incremented on this call ONLY when this is a RECLAIM — i.e. the task already had
 * a claim_ts from a previous claim (whether it lapsed back to the same agent or a different one).
 * A first-ever claim (status 'open', claim_ts null) leaves attempt_count at 0.
 */
export async function claimTask(
  id: string,
  agent: string,
  board = DEFAULT_BOARD,
  /** FND-20260829-878f: audit-only, see createTask's claimed_created_by doc comment -- `agent`
   *  above is already the token-bound value by the time it reaches here. */
  claimedActor?: string,
): Promise<{ task?: Task; conflict?: boolean; reason?: string; dead_lettered?: boolean }> {
  const who = normalizeAgent(agent);
  for (let attempt = 0; attempt < 2; attempt++) {
    const hit = await readDoc(TASKS, board, id);
    if (!hit) return { reason: 'not found' };
    const task = hit.doc as unknown as Task;
    if (task.status === 'done' || task.status === 'cancelled' || task.status === 'dead_letter') {
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

    // A14-DEAD-LETTER: this task has already been reclaimed MAX_CLAIM_ATTEMPTS times with no
    // one ever completing it — retire it instead of handing out yet another attempt. Checked BEFORE
    // mutating anything so a claim that would exceed the cap never increments attempt_count further
    // or extends a lease; it goes straight to dead_letter.
    const currentAttemptCount = task.attempt_count ?? 0;
    if (currentAttemptCount >= MAX_CLAIM_ATTEMPTS) {
      task.status = 'dead_letter';
      task.updated_at = now.toISOString();
      task.notes = [
        ...(task.notes ?? []),
        `[${now.toISOString()}] ${who}: claim refused — attempt_count (${currentAttemptCount}) reached MAX_CLAIM_ATTEMPTS (${MAX_CLAIM_ATTEMPTS}); dead-lettered instead of reclaimed.`,
      ];
      const res = await replaceDoc(TASKS, board, id, task as unknown as Record<string, unknown>, hit.etag ?? undefined);
      if (res.status === 412) continue; // lost the race; re-read and retry
      if (!res.ok) return { reason: `dead-letter transition failed: ${res.status}` };
      await appendEvent(
        id,
        'dead_lettered',
        who,
        `attempt_count ${currentAttemptCount} >= MAX_CLAIM_ATTEMPTS ${MAX_CLAIM_ATTEMPTS}; claim by ${who} refused`,
        claimedActor,
      );
      return { task, dead_lettered: true, reason: `task exceeded ${MAX_CLAIM_ATTEMPTS} claim attempts and has been dead-lettered` };
    }

    // A14-DEAD-LETTER: a RECLAIM is "this task already has a claim_ts from a previous claim
    // and is being claimed again" — true whether the previous holder's lease lapsed back to the same
    // agent or a different one. A brand-new task (status 'open', claim_ts null) is NOT a reclaim, so
    // its first claim leaves attempt_count untouched (stays 0).
    const isReclaim = task.status === 'claimed' && task.claim_ts !== null;
    if (isReclaim) {
      task.attempt_count = (task.attempt_count ?? 0) + 1;
    }

    task.owner_agent = who;
    task.status = 'claimed';
    task.claim_ts = now.toISOString();
    task.lease_until = new Date(now.getTime() + LEASE_MINUTES * 60000).toISOString();
    task.lease_version = (task.lease_version ?? 0) + 1;
    task.updated_at = now.toISOString();
    const res = await replaceDoc(TASKS, board, id, task as unknown as Record<string, unknown>, hit.etag ?? undefined);
    if (res.status === 412) continue; // lost the race; re-read and retry
    if (!res.ok) return { reason: `claim failed: ${res.status}` };
    await appendEvent(
      id,
      'claimed',
      who,
      `lease until ${task.lease_until} (lease_version ${task.lease_version}, attempt_count ${task.attempt_count})`,
      claimedActor,
    );
    return { task };
  }
  return { conflict: true, reason: 'concurrent claim, please retry' };
}

/** Extend a held lease so a long-running task isn't reclaimed mid-execution. Requires the caller
 *  to still be the current owner_agent; if expected_lease_version is passed and no longer matches,
 *  the lease was already reclaimed by someone else — reject rather than silently re-extending. */
export async function heartbeatTask(
  id: string,
  agent: string,
  board = DEFAULT_BOARD,
  expectedLeaseVersion?: number,
  /** FND-20260829-878f: audit-only, see createTask's claimed_created_by doc comment -- `agent`
   *  above is already the token-bound value by the time it reaches here. */
  claimedActor?: string,
): Promise<{ task?: Task; reason?: string; fenced?: boolean }> {
  const who = normalizeAgent(agent);
  const hit = await readDoc(TASKS, board, id);
  if (!hit) return { reason: 'not found' };
  const task = hit.doc as unknown as Task;
  if (task.status !== 'claimed' && task.status !== 'in_progress') {
    return { reason: `cannot heartbeat a task in status "${task.status}"` };
  }
  if (task.owner_agent !== who) {
    return { reason: `not the current lease holder (held by ${task.owner_agent})`, fenced: true };
  }
  if (expectedLeaseVersion !== undefined && task.lease_version !== expectedLeaseVersion) {
    return { reason: `stale lease_version (task is now at ${task.lease_version}) — your lease was reclaimed`, fenced: true };
  }
  const now = new Date();
  task.lease_until = new Date(now.getTime() + LEASE_MINUTES * 60000).toISOString();
  task.updated_at = now.toISOString();
  const res = await replaceDoc(TASKS, board, id, task as unknown as Record<string, unknown>, hit.etag ?? undefined);
  if (res.status === 412) return { reason: 'conflict, re-read and retry' };
  if (!res.ok) return { reason: `heartbeat failed: ${res.status}` };
  await appendEvent(id, 'heartbeat', who, `lease extended to ${task.lease_until}`, claimedActor);
  return { task };
}

export async function updateTask(
  id: string,
  patch: { status?: TaskStatus; note?: string; artifact_uri?: string; owner_agent?: string; priority?: Task['priority'] },
  actor: string,
  board = DEFAULT_BOARD,
  expectedLeaseVersion?: number,
  /** FND-20260829-878f: audit-only, see createTask's claimed_created_by doc comment -- `actor`
   *  above is already the token-bound value by the time it reaches here. Unrelated to
   *  patch.owner_agent, a legitimate caller-controlled reassignment target, untouched by this fix. */
  claimedActor?: string,
): Promise<{ task?: Task; reason?: string; fenced?: boolean }> {
  const hit = await readDoc(TASKS, board, id);
  if (!hit) return { reason: 'not found' };
  const task = hit.doc as unknown as Task;
  if (expectedLeaseVersion !== undefined && task.lease_version !== expectedLeaseVersion) {
    return { reason: `stale lease_version (task is now at ${task.lease_version}) — your lease was reclaimed`, fenced: true };
  }
  if (patch.status) task.status = patch.status;
  if (patch.priority) task.priority = patch.priority;
  if (patch.artifact_uri !== undefined) task.artifact_uri = patch.artifact_uri;
  if (patch.owner_agent) task.owner_agent = normalizeAgent(patch.owner_agent);
  if (patch.note) task.notes = [...(task.notes ?? []), `[${new Date().toISOString()}] ${actor}: ${patch.note}`];
  task.updated_at = new Date().toISOString();
  const res = await replaceDoc(TASKS, board, id, task as unknown as Record<string, unknown>, hit.etag ?? undefined);
  if (res.status === 412) return { reason: 'conflict, re-read and retry' };
  if (!res.ok) return { reason: `update failed: ${res.status}` };
  await appendEvent(id, 'updated', actor, JSON.stringify(patch).slice(0, 240), claimedActor);
  return { task };
}

/** Complete a task: REJECTS unless artifact_uri resolves. done = artifact landed. */
export async function completeTask(
  id: string,
  artifactUri: string,
  agent: string,
  note: string | undefined,
  board = DEFAULT_BOARD,
  expectedLeaseVersion?: number,
  /** FND-20260829-878f: audit-only, see createTask's claimed_created_by doc comment -- `agent`
   *  above is already the token-bound value by the time it reaches here. */
  claimedActor?: string,
): Promise<{ task?: Task; rejected?: boolean; reason?: string; resolution?: unknown; fenced?: boolean }> {
  const who = normalizeAgent(agent);
  const resolution = await resolveArtifact(artifactUri);
  if (!resolution.resolved) {
    await appendEvent(id, 'complete_rejected', who, `${artifactUri} :: ${resolution.detail}`, claimedActor);
    return {
      rejected: true,
      reason: `done = artifact landed. artifact_uri did not resolve (${resolution.scheme}: ${resolution.detail}). Land the work-product first (commons blob:, a resolvable URL, a cosmos: doc, or gh:).`,
      resolution,
    };
  }
  const hit = await readDoc(TASKS, board, id);
  if (!hit) return { reason: 'not found' };
  const task = hit.doc as unknown as Task;
  if (expectedLeaseVersion !== undefined && task.lease_version !== expectedLeaseVersion) {
    return { reason: `stale lease_version (task is now at ${task.lease_version}) — your lease was reclaimed, work may be duplicated`, fenced: true };
  }
  const now = new Date().toISOString();
  task.status = 'done';
  task.artifact_uri = artifactUri;
  task.done_ts = now;
  task.updated_at = now;
  if (note) task.notes = [...(task.notes ?? []), `[${now}] ${who} (done): ${note}`];
  const res = await replaceDoc(TASKS, board, id, task as unknown as Record<string, unknown>, hit.etag ?? undefined);
  if (res.status === 412) return { reason: 'conflict, re-read and retry' };
  if (!res.ok) return { reason: `complete failed: ${res.status}` };
  await appendEvent(id, 'completed', who, `artifact ${artifactUri} (${resolution.detail})`, claimedActor);
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

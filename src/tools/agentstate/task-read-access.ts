import type { Task } from '../../agentstate/ledger.js';
import { PERSONAL_LEGAL_RING } from '../kb/search-privileged.js';

export const PERSONAL_TASK_AGENT = 'clo-personal';

export interface TaskCoordinationProjection {
  id: string; board: string; type: 'task'; owner_agent: string; status: Task['status'];
  priority: Task['priority']; created_at: string; updated_at: string; claim_ts: string | null;
  lease_until: string | null; lease_version: number; done_ts: string | null; attempt_count: number;
}

function normalizeLane(value: string | undefined | null): string {
  return (value || '').trim().toLowerCase();
}

/** Only the existing personal-legal ring may read tasks owned or created by clo-personal. */
export function canReadPersonalTasks(callerAgent: string | undefined | null): boolean {
  return (PERSONAL_LEGAL_RING as readonly string[]).includes(normalizeLane(callerAgent));
}

export function isPersonalTask(task: Pick<Task, 'owner_agent' | 'created_by'>): boolean {
  return normalizeLane(task.owner_agent) === PERSONAL_TASK_AGENT || normalizeLane(task.created_by) === PERSONAL_TASK_AGENT;
}

export function taskVisibleToCaller(task: Pick<Task, 'owner_agent' | 'created_by'>, callerAgent: string | undefined | null): boolean {
  return !isPersonalTask(task) || canReadPersonalTasks(callerAgent);
}

/** Grants are sealed at creation. A later owner reassignment cannot grant historic content because owner_agent is mutable. Legacy tasks fall back to their immutable creator. */
export function canReadTaskDetails(task: Pick<Task, 'owner_agent' | 'created_by' | 'detail_readers'>, callerAgent: string | undefined | null): boolean {
  if (isPersonalTask(task)) return canReadPersonalTasks(callerAgent);
  const caller = normalizeLane(callerAgent);
  const readers = Array.isArray(task.detail_readers) && task.detail_readers.length > 0 ? task.detail_readers : [task.created_by];
  return readers.some((reader) => normalizeLane(reader) === caller);
}

/** Cross-seat coordination is status-only. It omits title, description, notes, tags, artifacts, idempotency keys, creator identity, and events. */
export function projectTaskForCaller(task: Task, callerAgent: string | undefined | null): Task | TaskCoordinationProjection {
  if (canReadTaskDetails(task, callerAgent)) return task;
  return { id: task.id, board: task.board, type: task.type, owner_agent: task.owner_agent, status: task.status, priority: task.priority, created_at: task.created_at, updated_at: task.updated_at, claim_ts: task.claim_ts, lease_until: task.lease_until, lease_version: task.lease_version, done_ts: task.done_ts, attempt_count: task.attempt_count ?? 0 };
}

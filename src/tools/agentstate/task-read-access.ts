import type { Task } from '../../agentstate/ledger.js';
import { PERSONAL_LEGAL_RING } from '../kb/search-privileged.js';

export const PERSONAL_TASK_AGENT = 'clo-personal';

function normalizeLane(value: string | undefined | null): string {
  return (value || '').trim().toLowerCase();
}

/** Only the existing personal-legal ring may read tasks owned or created by clo-personal. */
export function canReadPersonalTasks(callerAgent: string | undefined | null): boolean {
  return (PERSONAL_LEGAL_RING as readonly string[]).includes(normalizeLane(callerAgent));
}

export function isPersonalTask(task: Pick<Task, 'owner_agent' | 'created_by'>): boolean {
  return normalizeLane(task.owner_agent) === PERSONAL_TASK_AGENT ||
    normalizeLane(task.created_by) === PERSONAL_TASK_AGENT;
}

export function taskVisibleToCaller(
  task: Pick<Task, 'owner_agent' | 'created_by'>,
  callerAgent: string | undefined | null,
): boolean {
  return !isPersonalTask(task) || canReadPersonalTasks(callerAgent);
}

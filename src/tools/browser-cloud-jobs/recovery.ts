export const BROWSER_RECOVERY_MAX_LIMIT = 25;
export const BROWSER_RECOVERY_MAX_ATTEMPTS = 3;

const CLAIM_LEASE_MS = 30_000;

export type BrowserRecoveryEffect = 'none' | 'unknown' | 'succeeded';

export type BrowserPendingDispatch = {
  id: string;
  owner: string;
  version: number;
  status: 'pending';
  effect: BrowserRecoveryEffect;
  dueAt: number;
  attempts: number;
};

/** Indexed, bounded outbox operations with versioned claims and token fences. */
export interface BrowserRecoveryStore {
  listPending(now: number, limit: number): Promise<BrowserPendingDispatch[]>;
  claimDispatch(id: string, version: number, until: number): Promise<string | null>;
  markDispatched(id: string, token: string): Promise<boolean>;
  markReconciliation(id: string, token: string): Promise<boolean>;
}

export type BrowserRecoverySummary = {
  scanned: number;
  dispatched: number;
  reconciliation: number;
  skipped: number;
  failed: number;
};

export type BrowserExpiredSession = {
  id: string;
  owner: string;
  providerSessionId: string;
  ownership: 'confirmed' | 'unknown';
  version: number;
  status: 'cleanup_pending';
  /** Null means there is no known expiry and this row must not be stopped. */
  expiresAt: number | null;
};

/** Indexed, bounded cleanup operations with versioned claims and token fences. */
export interface BrowserExpiredSessionStore {
  listExpired(now: number, limit: number): Promise<BrowserExpiredSession[]>;
  claimCleanup(id: string, version: number, until: number): Promise<string | null>;
  markStopped(id: string, token: string): Promise<boolean>;
  markCleanupFailed(id: string, token: string): Promise<boolean>;
}

export type BrowserCleanupSummary = {
  scanned: number;
  stopped: number;
  failed: number;
  skipped: number;
};

function validate(now: number, limit: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - CLAIM_LEASE_MS) {
    throw new RangeError('now must leave room for a safe claim lease timestamp');
  }
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative safe integer');
  return Math.min(limit, BROWSER_RECOVERY_MAX_LIMIT);
}

function validDispatch(row: BrowserPendingDispatch, now: number): boolean {
  return row.id.length > 0 && row.owner.length > 0
    && Number.isSafeInteger(row.version) && row.version >= 0
    && row.status === 'pending'
    && (row.effect === 'none' || row.effect === 'unknown' || row.effect === 'succeeded')
    && Number.isSafeInteger(row.dueAt) && row.dueAt <= now
    && Number.isSafeInteger(row.attempts) && row.attempts >= 0;
}

async function markUncertainDispatch(store: BrowserRecoveryStore, id: string, token: string): Promise<boolean> {
  try { return await store.markReconciliation(id, token); } catch { return false; }
}

/** Redispatch only safe, due outbox rows, under a finite claim fence. */
export async function recoverBrowserDispatches(input: {
  store: BrowserRecoveryStore;
  dispatch: (jobId: string, owner: string) => Promise<void>;
  now: number;
  limit: number;
}): Promise<BrowserRecoverySummary> {
  const limit = validate(input.now, input.limit);
  const rows = limit === 0 ? [] : (await input.store.listPending(input.now, limit)).slice(0, limit);
  const result: BrowserRecoverySummary = { scanned: rows.length, dispatched: 0, reconciliation: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    if (!validDispatch(row, input.now)) { result.skipped++; continue; }
    const token = await input.store.claimDispatch(row.id, row.version, input.now + CLAIM_LEASE_MS);
    if (token === null) { result.skipped++; continue; }

    if (row.effect !== 'none' || row.attempts >= BROWSER_RECOVERY_MAX_ATTEMPTS) {
      if (await markUncertainDispatch(input.store, row.id, token)) result.reconciliation++;
      else result.failed++;
      continue;
    }

    try {
      await input.dispatch(row.id, row.owner);
    } catch {
      if (await markUncertainDispatch(input.store, row.id, token)) result.reconciliation++;
      else result.failed++;
      continue;
    }

    let recorded = false;
    try { recorded = await input.store.markDispatched(row.id, token); } catch { /* acknowledgement can be lost after commit */ }
    if (recorded) result.dispatched++;
    else if (await markUncertainDispatch(input.store, row.id, token)) result.reconciliation++;
    else result.failed++;
  }
  return result;
}

function validExpired(row: BrowserExpiredSession, now: number): boolean {
  return row.id.length > 0 && row.owner.length > 0 && row.providerSessionId.length > 0
    && row.ownership === 'confirmed'
    && Number.isSafeInteger(row.version) && row.version >= 0
    && row.status === 'cleanup_pending'
    && typeof row.expiresAt === 'number' && Number.isSafeInteger(row.expiresAt) && row.expiresAt <= now;
}

/** Stop only a positively owned session with a recorded expiry in the past. */
export async function cleanupExpiredBrowserSessions(input: {
  store: BrowserExpiredSessionStore;
  stop: (providerSessionId: string) => Promise<void>;
  now: number;
  limit: number;
}): Promise<BrowserCleanupSummary> {
  const limit = validate(input.now, input.limit);
  const rows = limit === 0 ? [] : (await input.store.listExpired(input.now, limit)).slice(0, limit);
  const result: BrowserCleanupSummary = { scanned: rows.length, stopped: 0, failed: 0, skipped: 0 };

  for (const row of rows) {
    if (!validExpired(row, input.now)) { result.skipped++; continue; }
    const token = await input.store.claimCleanup(row.id, row.version, input.now + CLAIM_LEASE_MS);
    if (token === null) { result.skipped++; continue; }

    try {
      await input.stop(row.providerSessionId);
    } catch {
      try {
        if (await input.store.markCleanupFailed(row.id, token)) result.failed++;
        else result.skipped++;
      } catch { result.failed++; }
      continue;
    }

    let recorded = false;
    try { recorded = await input.store.markStopped(row.id, token); } catch { /* acknowledgement can be lost after commit */ }
    if (recorded) result.stopped++;
    else {
      try { await input.store.markCleanupFailed(row.id, token); } catch { /* leave outcome visible as failed below */ }
      result.failed++;
    }
  }
  return result;
}

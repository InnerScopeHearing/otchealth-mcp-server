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
  /** Persist the uncertain dispatch intent before calling the queue adapter. */
  markDispatchEffectUnknown(id: string, token: string): Promise<boolean>;
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

function validDispatch(row: unknown, now: number): row is BrowserPendingDispatch {
  if (typeof row !== 'object' || row === null) return false;
  const value = row as Partial<BrowserPendingDispatch>;
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.owner === 'string' && value.owner.length > 0
    && Number.isSafeInteger(value.version) && value.version! >= 0
    && value.status === 'pending'
    && (value.effect === 'none' || value.effect === 'unknown' || value.effect === 'succeeded')
    && Number.isSafeInteger(value.dueAt) && value.dueAt! <= now
    && Number.isSafeInteger(value.attempts) && value.attempts! >= 0;
}

function validExpired(row: unknown, now: number): row is BrowserExpiredSession {
  if (typeof row !== 'object' || row === null) return false;
  const value = row as Partial<BrowserExpiredSession>;
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.owner === 'string' && value.owner.length > 0
    && typeof value.providerSessionId === 'string' && value.providerSessionId.length > 0
    && value.ownership === 'confirmed'
    && Number.isSafeInteger(value.version) && value.version! >= 0
    && value.status === 'cleanup_pending'
    && typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && value.expiresAt <= now;
}

async function markUncertainDispatch(store: BrowserRecoveryStore, id: string, token: string): Promise<boolean> {
  try { return await store.markReconciliation(id, token); } catch { return false; }
}

/** Recover a bounded set of safe outbox deliveries without replaying effects. */
export async function recoverBrowserDispatches(input: {
  store: BrowserRecoveryStore;
  /**
   * The adapter receives the claim fence. It must enforce that fence when it
   * can and deduplicate delivery by the same durable jobId across retries.
   */
  dispatch: (jobId: string, owner: string, token: string) => Promise<void>;
  now: number;
  limit: number;
}): Promise<BrowserRecoverySummary> {
  const limit = validate(input.now, input.limit);
  const rows = limit === 0 ? [] : (await input.store.listPending(input.now, limit)).slice(0, limit);
  const result: BrowserRecoverySummary = { scanned: rows.length, dispatched: 0, reconciliation: 0, skipped: 0, failed: 0 };

  for (const candidate of rows as unknown[]) {
    if (!validDispatch(candidate, input.now)) { result.skipped++; continue; }
    const row = candidate;
    let token: string | null;
    try { token = await input.store.claimDispatch(row.id, row.version, input.now + CLAIM_LEASE_MS); }
    catch { result.failed++; continue; }
    if (token === null) { result.skipped++; continue; }

    if (row.effect !== 'none' || row.attempts >= BROWSER_RECOVERY_MAX_ATTEMPTS) {
      if (await markUncertainDispatch(input.store, row.id, token)) result.reconciliation++;
      else result.failed++;
      continue;
    }

    let intentRecorded = false;
    try { intentRecorded = await input.store.markDispatchEffectUnknown(row.id, token); } catch { /* intent acknowledgement may be lost */ }
    if (!intentRecorded) {
      if (await markUncertainDispatch(input.store, row.id, token)) result.reconciliation++;
      else result.failed++;
      continue;
    }

    try {
      await input.dispatch(row.id, row.owner, token);
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

  for (const candidate of rows as unknown[]) {
    if (!validExpired(candidate, input.now)) { result.skipped++; continue; }
    const row = candidate;
    let token: string | null;
    try { token = await input.store.claimCleanup(row.id, row.version, input.now + CLAIM_LEASE_MS); }
    catch { result.failed++; continue; }
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
      try { await input.store.markCleanupFailed(row.id, token); } catch { /* preserve failed outcome */ }
      result.failed++;
    }
  }
  return result;
}

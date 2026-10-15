import { randomUUID } from 'node:crypto';
import type { CloudBrowserStore, CloudBrowserTransport } from './contract.js';
import { stopOwnedSession } from './session-stop.js';

type ExpiredSessionCleanupStore = CloudBrowserStore & {
  claimExpiredSessionCleanup(sessionId: string, owner: string, now: number, lockOwner: string, until: number): Promise<boolean>;
  deleteExpiredSessionUnderLock(sessionId: string, owner: string, lockOwner: string, now: number): Promise<boolean>;
};

/**
 * Recover one known, durably stored session. The existing table has no expiry
 * index, so callers must supply a session ID they already know; this never scans.
 */
export async function cleanupExpiredBrowserSession(input: {
  store: ExpiredSessionCleanupStore;
  transport: CloudBrowserTransport;
  sessionId: string;
  owner: string;
  now: number;
}): Promise<'stopped' | 'missing' | 'owner_mismatch' | 'profile_mismatch' | 'not_expired' | 'busy' | 'failed'> {
  if (!Number.isSafeInteger(input.now) || input.now < 0 || input.now > Number.MAX_SAFE_INTEGER - 60_000) throw new RangeError('now must leave room for a cleanup lease');
  const session = await input.store.loadSession(input.sessionId);
  if (!session) return 'missing';
  if (session.sessionId !== input.sessionId || session.owner !== input.owner) return 'owner_mismatch';
  if (session.expiresAt > input.now) return 'not_expired';

  // A profile record must still bind this exact profile to the durable session owner.
  const profile = await input.store.loadProfile(session.profileId);
  if (!profile || profile.profileId !== session.profileId || profile.owner !== session.owner || profile.ownerSubjectHash?.toLowerCase() !== session.ownerSubjectHash?.toLowerCase()) return 'profile_mismatch';

  const lockOwner = `recovery:${randomUUID()}`;
  if (!(await input.store.claimExpiredSessionCleanup(input.sessionId, input.owner, input.now, lockOwner, input.now + 60_000))) return 'busy';
  try {
    const current = await input.store.loadSession(input.sessionId);
    if (!current || current.sessionId !== input.sessionId || current.owner !== input.owner || current.profileId !== session.profileId || current.ownerSubjectHash?.toLowerCase() !== session.ownerSubjectHash?.toLowerCase() || current.expiresAt > input.now) return 'failed';
    // Provider transport receives the complete stored record, including original browser binding.
    await stopOwnedSession({ store: input.store, transport: input.transport, session: current, lockOwner });
    return await input.store.deleteExpiredSessionUnderLock(input.sessionId, input.owner, lockOwner, input.now) ? 'stopped' : 'failed';
  } catch {
    return 'failed';
  } finally {
    await input.store.releaseSessionLock(input.sessionId, lockOwner);
  }
}

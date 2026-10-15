import { createHash, randomUUID } from 'node:crypto';
import type { CloudBrowserAction } from '../browser-cloud/contract.js';
import { validateCloudBrowserAction } from '../browser-cloud/actions.js';
import { DaytonaBrowserError, type DaytonaBinding, type DaytonaBrowserStore, type DaytonaMission, type DaytonaProvider } from './contract.js';
import { assertDaytonaBinding, assertDaytonaMission } from './store.js';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (code: string): never => { throw new DaytonaBrowserError(code); };
export function daytonaProfileKey(owner: string, principalHash: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{1,30}$/.test(owner) || !HASH.test(principalHash)) return fail('owner_forbidden');
  return `${owner}-${principalHash}`;
}
const displayLease = (binding: DaytonaBinding) => `display-${createHash('sha256').update(binding.sandboxId).digest('hex').slice(0, 40)}`;
/** Only logical missions on exact approved enrollment. No create/start/delete sandbox capability. */
export class DaytonaBrowserService {
  constructor(private readonly store: DaytonaBrowserStore, private readonly provider: DaytonaProvider, private readonly now: () => number = Date.now) {}
  private async binding(caller: string, key: string, principal?: string): Promise<DaytonaBinding> {
    if (!principal || !HASH.test(principal)) return fail('owner_forbidden');
    const binding = await this.store.loadBinding(key); if (!binding) return fail('profile_not_enrolled'); assertDaytonaBinding(binding);
    if (binding.owner !== caller || binding.ownerSubjectHash !== principal || binding.profileKey !== key) return fail('owner_forbidden'); return binding;
  }
  private async mission(caller: string, id: string, principal?: string, allowExpired = false): Promise<{ binding: DaytonaBinding; session: DaytonaMission }> {
    const session = await this.store.loadSession(id); if (!session) return fail('owner_forbidden'); assertDaytonaMission(session);
    if (!principal || session.owner !== caller || session.ownerSubjectHash !== principal) return fail('owner_forbidden');
    const binding = await this.binding(caller, session.profileKey, principal); if (binding.sandboxId !== session.sandboxId) return fail('owner_forbidden');
    if (!allowExpired && session.expiresAt <= this.now()) return fail('session_expired'); return { binding, session };
  }
  private async locked<T>(caller: string, id: string, principal: string | undefined, run: (binding: DaytonaBinding, session: DaytonaMission, lock: string) => Promise<T>, allowExpired = false): Promise<T> {
    await this.mission(caller, id, principal, allowExpired); const lock = randomUUID();
    if (!await this.store.acquireSessionLock(id, lock, this.now() + 300000)) return fail('session_busy');
    try { const { binding, session } = await this.mission(caller, id, principal, allowExpired); return await run(binding, session, lock); }
    finally { await this.store.releaseSessionLock(id, lock); }
  }
  private async active(binding: DaytonaBinding, session: DaytonaMission, allowHuman = false): Promise<void> {
    if (session.phase !== 'ACTIVE') return fail('session_unavailable'); if (session.effectUnknown) return fail('effect_unknown');
    if (!allowHuman && session.sensitiveOutputSuppressed) return fail('sensitive_output_suppressed');
    if (!await this.store.ownsProfileLease(binding.profileKey, session.sessionId) || !await this.store.ownsProfileLease(displayLease(binding), session.sessionId)) return fail('profile_busy');
  }
  async start(caller: string, profileKey: string, maxSeconds: number, actionBudget = 10000, principal?: string): Promise<{ sessionId: string; expiresAt: number }> {
    if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 28800) return fail('invalid_duration');
    if (!Number.isSafeInteger(actionBudget) || actionBudget < 1 || actionBudget > 10000) return fail('invalid_action_budget');
    const binding = await this.binding(caller, profileKey, principal); const inspection = await this.provider.inspect(binding);
    if (inspection.sandboxId !== binding.sandboxId || inspection.state !== 'started' || inspection.public !== false) return fail('daytona_not_ready');
    const sessionId = randomUUID(); const expiresAt = this.now() + maxSeconds * 1000;
    if (!await this.store.acquireProfileLease(displayLease(binding), sessionId, expiresAt + 300000)) return fail('profile_busy');
    if (!await this.store.acquireProfileLease(profileKey, sessionId, expiresAt + 300000)) { await this.store.releaseProfileLease(displayLease(binding), sessionId); return fail('profile_busy'); }
    const session: DaytonaMission = { provider: 'daytona', sessionId, owner: caller, ownerSubjectHash: principal!, profileKey, sandboxId: binding.sandboxId, expiresAt, actionsUsed: 0, actionBudget, effectUnknown: true, phase: 'OPENING' };
    let openingAttempted = false;
    try {
      if (!await this.store.createSession(session)) return fail('session_conflict');
      return await this.locked(caller, sessionId, principal, async (_binding, current, lock) => {
        openingAttempted = true; await this.provider.openMission(binding, sessionId); if (current.expiresAt <= this.now()) return fail('session_expired');
        current.phase = 'ACTIVE'; current.effectUnknown = false; await this.store.saveSessionUnderLock(current, lock); return { sessionId, expiresAt };
      });
    } catch (error) {
      if (!openingAttempted) { await this.store.releaseProfileLease(profileKey, sessionId); await this.store.releaseProfileLease(displayLease(binding), sessionId); } throw error;
    }
  }
  async execute(caller: string, id: string, action: CloudBrowserAction, timeoutSeconds: number, principal?: string): Promise<unknown> {
    const checked = validateCloudBrowserAction(action); if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) return fail('invalid_duration');
    return this.locked(caller, id, principal, async (binding, session, lock) => {
      await this.active(binding, session); if (session.actionsUsed >= session.actionBudget) return fail('action_limit');
      session.actionsUsed++; session.effectUnknown = true; await this.store.saveSessionUnderLock(session, lock);
      const result = await this.provider.execute(binding, session, checked, timeoutSeconds, principal!); session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock); return result;
    });
  }
  async snapshot(caller: string, id: string, principal?: string): Promise<unknown> { return this.execute(caller, id, { type: 'snapshot' }, 20, principal); }
  async savePersistentProfile(caller: string, id: string, principal?: string): Promise<void> {
    await this.locked(caller, id, principal, async (binding, session, lock) => { await this.active(binding, session); session.effectUnknown = true; await this.store.saveSessionUnderLock(session, lock); await this.provider.checkpoint(binding); session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock); });
  }
  async stop(caller: string, id: string, principal?: string): Promise<void> {
    await this.locked(caller, id, principal, async (binding, session, lock) => {
      if (session.phase !== 'CLOSED') {
        if (!await this.store.ownsProfileLease(binding.profileKey, session.sessionId) || !await this.store.ownsProfileLease(displayLease(binding), session.sessionId)) return fail('profile_busy');
        // A lost grant acknowledgement may leave an active viewer whose opaque
        // handle was never stored. Do not release the desktop for a successor.
        if (session.sensitiveOutputSuppressed && session.effectUnknown && !session.viewerGrantHandle) return fail('viewer_revocation_unknown');
        session.phase = 'RELEASING'; session.effectUnknown = true; await this.store.saveSessionUnderLock(session, lock);
        if (session.viewerGrantHandle) { const receipt = await this.provider.revokeViewerGrant(binding, session.viewerGrantHandle); if (receipt.human_input_revoked !== true) return fail('viewer_revocation_unknown'); }
        await this.provider.releaseMission(binding, session); session.phase = 'CLOSED'; session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock);
      }
      await this.store.releaseProfileLease(binding.profileKey, session.sessionId); await this.store.releaseProfileLease(displayLease(binding), session.sessionId);
    }, true);
  }
  async discover(caller: string, principal?: string, profileKey?: string): Promise<{ profileId: string; allowedHosts: string[]; persistent: true; provider: 'daytona' }> {
    if (!principal) return fail('owner_forbidden'); const binding = await this.binding(caller, profileKey ?? daytonaProfileKey(caller, principal), principal); return { profileId: binding.profileKey, allowedHosts: [], persistent: true, provider: 'daytona' };
  }
  async getViewerGrant(caller: string, id: string, principal?: string, requestedSeconds = 300): Promise<{ url: string; expiresAt: number; grantHandle: string }> {
    if (!Number.isSafeInteger(requestedSeconds) || requestedSeconds < 1 || requestedSeconds > 300) return fail('invalid_duration');
    return this.locked(caller, id, principal, async (binding, session, lock) => {
      await this.active(binding, session); const seconds = Math.min(requestedSeconds, Math.floor((session.expiresAt - this.now()) / 1000)); if (seconds < 1) return fail('session_expired');
      session.sensitiveOutputSuppressed = true; session.effectUnknown = true; await this.store.saveSessionUnderLock(session, lock);
      const grant = await this.provider.viewerGrant(binding, seconds); let url: URL; try { url = new URL(grant.url); } catch { return fail('viewer_grant_invalid'); }
      if (url.protocol !== 'https:' || url.username || url.password || !UUID.test(grant.grantHandle) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= this.now() || grant.expiresAt > Math.min(session.expiresAt, this.now() + seconds * 1000)) return fail('viewer_grant_invalid');
      session.viewerGrantHandle = grant.grantHandle; session.viewerExpiresAt = grant.expiresAt; session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock); return grant;
    });
  }
  async resumeViewerGrant(caller: string, id: string, principal: string | undefined, expectedHandle: string): Promise<{ url: string; expiresAt: number; grantHandle: string }> {
    if (!UUID.test(expectedHandle)) return fail('viewer_unavailable');
    return this.locked(caller, id, principal, async (binding, session) => {
      await this.active(binding, session, true);
      if (!session.sensitiveOutputSuppressed || session.viewerGrantHandle !== expectedHandle || !session.viewerExpiresAt || session.viewerExpiresAt <= this.now()) return fail('viewer_unavailable');
      const grant = await this.provider.readViewerGrant(binding, expectedHandle);
      let url: URL; try { url = new URL(grant.url); } catch { return fail('viewer_grant_invalid'); }
      if (grant.grantHandle !== expectedHandle || grant.expiresAt !== session.viewerExpiresAt || grant.expiresAt > session.expiresAt || grant.expiresAt <= this.now() || url.protocol !== 'https:' || url.username || url.password) return fail('viewer_grant_invalid');
      return grant;
    });
  }
  async completeHumanInput(caller: string, id: string, principal?: string): Promise<{ status: 'saved'; human_input_revoked: true }> {
    return this.locked(caller, id, principal, async (binding, session, lock) => {
      await this.active(binding, session, true); if (!session.viewerGrantHandle || !session.sensitiveOutputSuppressed) return fail('viewer_unavailable');
      session.effectUnknown = true; await this.store.saveSessionUnderLock(session, lock); const receipt = await this.provider.revokeViewerGrant(binding, session.viewerGrantHandle); if (receipt.human_input_revoked !== true) return fail('viewer_revocation_unknown');
      await this.provider.checkpoint(binding); delete session.viewerGrantHandle; delete session.viewerExpiresAt; session.sensitiveOutputSuppressed = false; session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock); return { status: 'saved', human_input_revoked: true };
    });
  }
}

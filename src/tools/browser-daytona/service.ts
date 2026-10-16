import { createHash, randomUUID } from 'node:crypto';
import type { CloudBrowserAction } from '../browser-cloud/contract.js';
import { validateCloudBrowserAction } from '../browser-cloud/actions.js';
import { DaytonaBrowserError, type DaytonaBinding, type DaytonaBrowserStore, type DaytonaMission, type DaytonaProvider, type DaytonaRuntimeReadiness } from './contract.js';
import { assertDaytonaBinding, assertDaytonaMission } from './store.js';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (code: string): never => { throw new DaytonaBrowserError(code); };
export function daytonaProfileKey(owner: string, principalHash: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{1,30}$/.test(owner) || !HASH.test(principalHash)) return fail('owner_forbidden');
  return `${owner}-${principalHash}`;
}
const displayLease = (binding: Pick<DaytonaBinding, 'sandboxId'>) => `display-${createHash('sha256').update(binding.sandboxId).digest('hex').slice(0, 40)}`;
const beforeEffectBusy = (session: DaytonaMission, error: unknown) => session.runtimeProtocol === 2 && error instanceof DaytonaBrowserError && error.code === 'daytona_operation_busy';
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
    if (!await this.store.ownsProfileLease(binding.profileKey, session.sessionId) || (session.runtimeProtocol !== 2 && !await this.store.ownsProfileLease(displayLease(binding), session.sessionId))) return fail('profile_busy');
  }
  async start(caller: string, profileKey: string, maxSeconds: number, actionBudget = 10000, principal?: string, options?: { requireMultiMission?: boolean }): Promise<{ sessionId: string; expiresAt: number; runtimeProtocol?: 2 }> {
    if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 28800) return fail('invalid_duration');
    if (!Number.isSafeInteger(actionBudget) || actionBudget < 1 || actionBudget > 10000) return fail('invalid_action_budget');
    const binding = await this.binding(caller, profileKey, principal); const inspection = await this.provider.inspect(binding);
    if (inspection.sandboxId !== binding.sandboxId || inspection.state !== 'started' || inspection.public !== false) return fail('daytona_not_ready');
    const proof = this.provider.probe ? await this.readiness(caller, profileKey, principal) : undefined;
    const multiMission = proof?.runtimeProtocol === 2 && proof.multiMissionReady === true;
    if (proof?.runtimeProtocol === 2 && !multiMission) return fail('daytona_operation_busy');
    if (options?.requireMultiMission && (!multiMission || proof?.checkpointReady !== true)) return fail('daytona_multimission_unavailable');
    const sessionId = randomUUID(); const expiresAt = this.now() + maxSeconds * 1000;
    if (!multiMission && !await this.store.acquireProfileLease(displayLease(binding), sessionId, expiresAt + 300000)) return fail('profile_busy');
    if (!await this.store.acquireProfileLease(profileKey, sessionId, expiresAt + 300000)) { if (!multiMission) await this.store.releaseProfileLease(displayLease(binding), sessionId); return fail('profile_busy'); }
    const session: DaytonaMission = { provider: 'daytona', sessionId, owner: caller, ownerSubjectHash: principal!, profileKey, sandboxId: binding.sandboxId, expiresAt, actionsUsed: 0, actionBudget, effectUnknown: true, phase: 'OPENING', ...(multiMission ? { runtimeProtocol: 2 } : {}) };
    let openingAttempted = false, provenNotOpened = false;
    try {
      // A trusted migration atomically requires this profile lease absent. A
      // starter that read before its CAS must not use the stale physical SID.
      const currentBinding = await this.binding(caller, profileKey, principal);
      if (Object.keys(currentBinding).length !== Object.keys(binding).length || Object.entries(binding).some(([key, value]) => currentBinding[key as keyof DaytonaBinding] !== value)) return fail('daytona_binding_changed');
      if (!await this.store.createSession(session)) return fail('session_conflict');
      return await this.locked(caller, sessionId, principal, async (_binding, current, lock) => {
        openingAttempted = true;
        try { await this.provider.openMission(binding, sessionId, multiMission ? { runtimeProtocol: 2 } : undefined); }
        catch (error) {
          if (beforeEffectBusy(current, error)) { current.phase = 'CLOSED'; current.effectUnknown = false; await this.store.saveSessionUnderLock(current, lock); provenNotOpened = true; }
          throw error;
        }
        if (current.expiresAt <= this.now()) return fail('session_expired');
        current.phase = 'ACTIVE'; current.effectUnknown = false; await this.store.saveSessionUnderLock(current, lock); return { sessionId, expiresAt, ...(multiMission ? { runtimeProtocol: 2 as const } : {}) };
      });
    } catch (error) {
      if (!openingAttempted || provenNotOpened) { await this.store.releaseProfileLease(profileKey, sessionId); if (!multiMission) await this.store.releaseProfileLease(displayLease(binding), sessionId); } throw error;
    }
  }
  async execute(caller: string, id: string, action: CloudBrowserAction, timeoutSeconds: number, principal?: string): Promise<unknown> {
    const checked = validateCloudBrowserAction(action); if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) return fail('invalid_duration');
    return this.locked(caller, id, principal, async (binding, session, lock) => {
      await this.active(binding, session); if (session.actionsUsed >= session.actionBudget) return fail('action_limit');
      if (session.runtimeProtocol === 2 && checked.type === 'press_key' && ((checked.modifiers ?? 0) & 6) && ['KeyP', 'KeyS', 'KeyF'].includes(checked.key)) return fail('daytona_global_shortcut_unsupported');
      if (session.runtimeProtocol === 2 && checked.type === 'press_key' && ['KeyC', 'KeyV'].includes(checked.key) && ((checked.modifiers ?? 0) & 6) && ![2, 4, 6].includes(checked.modifiers ?? 0)) return fail('daytona_clipboard_modifier_unsupported');
      session.actionsUsed++; session.effectUnknown = true; await this.store.saveSessionUnderLock(session, lock);
      let result: unknown;
      try { result = await this.provider.execute(binding, session, checked, timeoutSeconds, principal!); }
      catch (error) { if (beforeEffectBusy(session, error)) { session.actionsUsed--; session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock); } throw error; }
      session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock);
      if (result && typeof result === 'object' && 'observation' in result) {
        const execution = result as { observation: unknown; pageReceipt?: unknown };
        return execution.pageReceipt ?? execution.observation;
      }
      return result;
    });
  }
  async snapshot(caller: string, id: string, principal?: string): Promise<unknown> { return this.execute(caller, id, { type: 'snapshot' }, 20, principal); }
  async savePersistentProfile(caller: string, id: string, principal?: string): Promise<void> {
    await this.locked(caller, id, principal, async (binding, session, lock) => { await this.active(binding, session); session.effectUnknown = true; await this.store.saveSessionUnderLock(session, lock);
      try { await this.provider.checkpoint(binding, session); }
      catch (error) { if (beforeEffectBusy(session, error)) { session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock); } throw error; }
      session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock); });
  }
  async stop(caller: string, id: string, principal?: string): Promise<void> {
    const receipt = await this.store.loadSession(id);
    if (receipt) {
      assertDaytonaMission(receipt);
      if (receipt.sessionId !== id || !principal || receipt.owner !== caller || receipt.ownerSubjectHash !== principal) return fail('owner_forbidden');
      if (receipt.phase === 'CLOSED' && !receipt.effectUnknown) {
        // Historical receipts retain their original SID after a quiescent
        // enrollment migration. Never resolve/wake the successor desktop.
        // Exact-owner conditional deletes also finish a prior lost cleanup ACK.
        await this.store.releaseProfileLease(receipt.profileKey, receipt.sessionId);
        if (receipt.runtimeProtocol !== 2) await this.store.releaseProfileLease(displayLease(receipt), receipt.sessionId);
        return;
      }
    }
    await this.locked(caller, id, principal, async (binding, session, lock) => {
      if (session.phase !== 'CLOSED') {
        if (!await this.store.ownsProfileLease(binding.profileKey, session.sessionId) || (session.runtimeProtocol !== 2 && !await this.store.ownsProfileLease(displayLease(binding), session.sessionId))) return fail('profile_busy');
        // A lost grant acknowledgement may leave an active viewer whose opaque
        // handle was never stored. Do not release the desktop for a successor.
        if (session.sensitiveOutputSuppressed && session.effectUnknown && !session.viewerGrantHandle) return fail('viewer_revocation_unknown');
        session.phase = 'RELEASING'; session.effectUnknown = true; await this.store.saveSessionUnderLock(session, lock);
        if (session.viewerGrantHandle) { const receipt = await this.provider.revokeViewerGrant(binding, session.viewerGrantHandle); if (receipt.human_input_revoked !== true) return fail('viewer_revocation_unknown'); }
        await this.provider.releaseMission(binding, session); session.phase = 'CLOSED'; session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock);
      }
      await this.store.releaseProfileLease(binding.profileKey, session.sessionId); if (session.runtimeProtocol !== 2) await this.store.releaseProfileLease(displayLease(binding), session.sessionId);
    }, true);
  }
  async discover(caller: string, principal?: string, profileKey?: string): Promise<{ profileId: string; allowedHosts: string[]; persistent: true; provider: 'daytona' }> {
    if (!principal) return fail('owner_forbidden'); const binding = await this.binding(caller, profileKey ?? daytonaProfileKey(caller, principal), principal); return { profileId: binding.profileKey, allowedHosts: [], persistent: true, provider: 'daytona' };
  }
  /** No mission, lease, or resource creation. Call before routing a full human-enabled alias. */
  async readiness(caller: string, profileKey: string, principal?: string): Promise<DaytonaRuntimeReadiness> {
    const binding = await this.binding(caller, profileKey, principal);
    if (!this.provider.probe) return fail('daytona_checkpoint_unavailable');
    const proof = await this.provider.probe(binding);
    if (!proof || proof.ready !== true || proof.profileKey !== binding.profileKey || proof.profilePath !== binding.profilePath || typeof proof.checkpointReady !== 'boolean') return fail('daytona_runtime_invalid');
    if ((proof.runtimeProtocol !== undefined && proof.runtimeProtocol !== 2) || (proof.runtimeProtocol === 2 && typeof proof.multiMissionReady !== 'boolean') || (proof.runtimeProtocol === undefined && proof.multiMissionReady !== undefined)) return fail('daytona_runtime_invalid');
    return { ready: true, profileKey: binding.profileKey, profilePath: binding.profilePath, checkpointReady: proof.checkpointReady,
      ...(proof.runtimeProtocol === 2 ? { runtimeProtocol: 2, multiMissionReady: proof.multiMissionReady } : {}),
      ...(proof.browserPid === undefined ? {} : { browserPid: proof.browserPid }), ...(proof.supervisorPid === undefined ? {} : { supervisorPid: proof.supervisorPid }) };
  }
  async getViewerGrant(caller: string, id: string, principal?: string, requestedSeconds = 300, notAfter?: number): Promise<{ url: string; expiresAt: number; grantHandle: string }> {
    if (!Number.isSafeInteger(requestedSeconds) || requestedSeconds < 1 || requestedSeconds > 300 || (notAfter !== undefined && (!Number.isSafeInteger(notAfter) || notAfter <= this.now()))) return fail('invalid_duration');
    return this.locked(caller, id, principal, async (binding, session, lock) => {
      await this.active(binding, session);
      // Relative seconds computed before readiness/pause can outlive a shorter
      // handoff ticket. Preserve that original absolute cap through minting.
      const grantDeadline = Math.min(session.expiresAt, notAfter ?? session.expiresAt);
      const seconds = Math.min(requestedSeconds, Math.floor((grantDeadline - this.now()) / 1000)); if (seconds < 1) return fail('session_expired');
      if (session.runtimeProtocol === 2 && (!this.provider.pauseAutomation || !this.provider.resumeAutomation)) return fail('daytona_handoff_unavailable');
      session.sensitiveOutputSuppressed = true; session.effectUnknown = true; await this.store.saveSessionUnderLock(session, lock);
      if (session.runtimeProtocol === 2) {
        try { const paused = await this.provider.pauseAutomation!(binding, session); if (paused.paused !== true) return fail('daytona_pause_unconfirmed'); }
        catch (error) { if (beforeEffectBusy(session, error)) { session.sensitiveOutputSuppressed = false; session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock); } throw error; }
      }
      const grant = await this.provider.viewerGrant(binding, seconds, grantDeadline);
      if (!UUID.test(grant.grantHandle)) return fail('viewer_grant_invalid');
      // A UUID alone is not ownership proof. The trusted vault read is bound to
      // this enrollment; a foreign handle must never become a cleanup target.
      let owned: typeof grant;
      try { owned = await this.provider.readViewerGrant(binding, grant.grantHandle); }
      catch (error) {
        // An expired read is not proof that input was revoked. Only a positive
        // binding-checked revoke permits retaining this handle for cleanup.
        try {
          const receipt = await this.provider.revokeViewerGrant(binding, grant.grantHandle);
          if (receipt.human_input_revoked === true) {
            session.viewerGrantHandle = grant.grantHandle;
            session.viewerExpiresAt = Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > 0 ? Math.min(grant.expiresAt, grantDeadline) : grantDeadline;
            await this.store.saveSessionUnderLock(session, lock);
          }
        } catch { /* foreign or unknown handle stays untrusted and fenced */ }
        throw error;
      }
      if (owned.grantHandle !== grant.grantHandle || !Number.isSafeInteger(owned.expiresAt) || owned.expiresAt <= 0) return fail('viewer_grant_invalid');
      session.viewerGrantHandle = owned.grantHandle; session.viewerExpiresAt = Math.min(owned.expiresAt, grantDeadline);
      await this.store.saveSessionUnderLock(session, lock);
      try {
        const url = new URL(grant.url);
        if (grant.url !== owned.url || grant.expiresAt !== owned.expiresAt || url.protocol !== 'https:' || url.username || url.password || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= this.now() || grant.expiresAt > Math.min(grantDeadline, this.now() + seconds * 1000)) return fail('viewer_grant_invalid');
      } catch {
        // Keep the durable handle/unknown fence even if cleanup or its ACK is
        // lost. stop() can then retry only the vault's governed revoke path.
        try { await this.provider.revokeViewerGrant(binding, owned.grantHandle); } catch { /* unknown cleanup stays fenced */ }
        return fail('viewer_grant_invalid');
      }
      session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock); return grant;
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
      await this.provider.checkpoint(binding, session);
      if (session.runtimeProtocol === 2) { if (!this.provider.resumeAutomation) return fail('daytona_handoff_unavailable'); const resumed = await this.provider.resumeAutomation(binding, session); if (resumed.resumed !== true) return fail('daytona_resume_unconfirmed'); }
      delete session.viewerGrantHandle; delete session.viewerExpiresAt; session.sensitiveOutputSuppressed = false; session.effectUnknown = false; await this.store.saveSessionUnderLock(session, lock); return { status: 'saved', human_input_revoked: true };
    });
  }
}

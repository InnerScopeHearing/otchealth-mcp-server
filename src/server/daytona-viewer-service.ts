import type { DaytonaViewerService } from './daytona-viewer.js';
import { createHash, randomBytes } from 'node:crypto';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../search/sigv4.js';

export interface DaytonaViewerMission {
  sessionId: string; owner: string; ownerSubjectHash: string; expiresAt: number; phase: string; effectUnknown: boolean; profileLeaseReleased?: boolean;
  viewerGrantHandle?: string;
  humanInputReceipt?: { grantHandle: string; completedAt: number; human_input_revoked: true; profile_checkpointed: true; automation_resumed: true };
}
export interface DaytonaViewerGrant { url: string; expiresAt: number; grantHandle: string }
export interface DaytonaViewerMissionBoundary {
  loadSession(id: string): Promise<DaytonaViewerMission | null>;
  getViewerGrant(owner: string, id: string, principal: string, seconds: number, notAfter: number): Promise<DaytonaViewerGrant>;
  resumeViewerGrant(owner: string, id: string, principal: string, handle: string): Promise<DaytonaViewerGrant>;
  completeHumanInput(owner: string, id: string, principal: string): Promise<{ status: 'saved'; human_input_revoked: true; receipt: NonNullable<DaytonaViewerMission['humanInputReceipt']> }>;
  renewViewerGrant(owner: string, id: string, principal: string, handle: string, notAfter: number): Promise<DaytonaViewerGrant>;
  // Must resolve only after positive owned-grant revocation AND confirmed logical
  // mission release. Never map a queued/unknown stop response to this contract.
  stop(owner: string, id: string, principal: string): Promise<void>;
}
export type DaytonaViewerPhase = 'NEW' | 'ISSUING' | 'EXCHANGED' | 'RESUMING' | 'RENEWING' | 'COMPLETING' | 'EXPIRING' | 'SAVED' | 'EXPIRED';
export type DaytonaViewerFailure = 'opening_expired' | 'mission_expired' | 'mission_revoked' | 'recovery_state_missing' | 'operation_pending' | 'desktop_unavailable';
export class DaytonaViewerError extends Error {
  constructor(readonly code: DaytonaViewerFailure) { super(code); this.name = 'DaytonaViewerError'; }
}
const fail = (code: DaytonaViewerFailure): never => { throw new DaytonaViewerError(code); };
export interface DaytonaViewerTicket {
  owner: string; principalHash: string; sessionId: string; expiresAt: number; phase: DaytonaViewerPhase; version: number;
  targetSite?: 'wefunder'; grantHandle?: string; grantExpiresAt?: number;
  missionExpiresAt?: number; browserHash?: string; recoveryUntil?: number;
}
export interface DaytonaViewerTicketStore {
  create(hash: string, ticket: DaytonaViewerTicket): Promise<boolean>;
  load(hash: string): Promise<DaytonaViewerTicket | null>;
  transition(hash: string, phase: DaytonaViewerPhase, next: DaytonaViewerTicket): Promise<boolean>;
  acquireMissionLease(id: string, hash: string): Promise<boolean>;
  ownsMissionLease(id: string, hash: string): Promise<boolean>;
  releaseMissionLease(id: string, hash: string): Promise<void>;
  bindBrowser(hash: string, selector: string, browserHash: string, recoveryUntil: number, next: DaytonaViewerTicket): Promise<boolean>;
  loadByBrowser(selector: string, browserHash: string): Promise<{ hash: string; ticket: DaytonaViewerTicket } | null>;
}
export class DaytonaViewerHandoffService implements DaytonaViewerService {
  constructor(private readonly store: DaytonaViewerTicketStore, private readonly missions: DaytonaViewerMissionBoundary, private readonly now: () => number = Date.now) {}
  private async owned(row: DaytonaViewerTicket, allowOpeningExpired = false, allowMissionExpired = allowOpeningExpired): Promise<void> {
    const mission = await this.missions.loadSession(row.sessionId);
    if (!mission || mission.sessionId !== row.sessionId || mission.owner !== row.owner || mission.ownerSubjectHash !== row.principalHash
      || mission.phase !== 'ACTIVE' || mission.effectUnknown || (!allowOpeningExpired && row.expiresAt <= this.now()) || (!allowMissionExpired && mission.expiresAt <= this.now())
      || (row.grantHandle && mission.viewerGrantHandle !== row.grantHandle)) throw new Error('viewer_unavailable');
  }
  private async validateForBrowser(row: DaytonaViewerTicket, allowOpeningExpired = false): Promise<DaytonaViewerMission> {
    const mission = await this.missions.loadSession(row.sessionId);
    if (!mission || mission.sessionId !== row.sessionId || mission.owner !== row.owner || mission.ownerSubjectHash !== row.principalHash) return fail('mission_revoked');
    if (mission.phase !== 'ACTIVE') return fail('mission_revoked');
    if (mission.effectUnknown) return fail('operation_pending');
    if (mission.expiresAt <= this.now()) return fail('mission_expired');
    if (!allowOpeningExpired && row.expiresAt <= this.now()) return fail('opening_expired');
    if (row.grantHandle && mission.viewerGrantHandle !== row.grantHandle) return fail('operation_pending');
    return mission;
  }
  async issue(owner: string, id: string, principal: string, seconds = 300, targetSite?: 'wefunder'): Promise<{ login_url: string; expires_at: number }> {
    if (typeof owner !== 'string' || typeof id !== 'string' || typeof principal !== 'string' || !ID.test(owner) || !ID.test(id) || !HASH.test(principal) || !Number.isInteger(seconds) || seconds < 1 || seconds > 600 || (targetSite !== undefined && targetSite !== 'wefunder')) throw new Error('viewer_unavailable');
    const mission = await this.missions.loadSession(id);
    const missionExpiresAt = mission?.expiresAt ?? 0;
    const expiresAt = Math.min(this.now() + seconds * 1000, missionExpiresAt);
    const row: DaytonaViewerTicket = { owner, sessionId: id, principalHash: principal, expiresAt, missionExpiresAt, phase: 'NEW', version: 0, ...(targetSite ? { targetSite } : {}) };
    await this.owned(row);
    const token = randomBytes(32).toString('base64url'), hash = digest(token);
    if (!await this.store.acquireMissionLease(id, hash)) throw new Error('viewer_unavailable');
    // A lost create acknowledgement retains the exact lease for reconciliation;
    // never delete it speculatively and issue a second bearer capability.
    if (!await this.store.create(hash, row)) throw new Error('viewer_unavailable');
    return { login_url: `https://mcp.otchealth.app/browser/daytona#token=${token}`, expires_at: expiresAt };
  }
  async prepare(token: string, browserProof: string): Promise<{ handoff_id: string; opening_expires_at: number; mission_expires_at: number; target_label?: 'WeFunder' }> {
    if (!TOKEN.test(token) || !TOKEN.test(browserProof)) fail('recovery_state_missing');
    const hash = digest(token), current = await this.store.load(hash), browserHash = digest(browserProof);
    if (!current) return fail('recovery_state_missing');
    if (!['NEW', 'EXCHANGED'].includes(current.phase)) return fail('operation_pending');
    if (!await this.store.ownsMissionLease(current.sessionId, hash)) return fail('mission_revoked');
    const mission = await this.validateForBrowser(current);
    const missionExpiresAt = current.missionExpiresAt ?? current.expiresAt;
    const recoveryUntil = current.recoveryUntil ?? missionExpiresAt;
    if (recoveryUntil <= this.now()) return fail('mission_expired');
    if (current.browserHash && current.browserHash !== browserHash) return fail('recovery_state_missing');
    if (mission.expiresAt !== missionExpiresAt) return fail('operation_pending');
    const next = { ...current, browserHash, recoveryUntil, version: current.version + (current.browserHash ? 0 : 1) };
    if (!await this.store.bindBrowser(hash, hash.slice(0, 32), browserHash, recoveryUntil, next)) return fail('operation_pending');
    return { handoff_id: hash.slice(0, 32), opening_expires_at: current.expiresAt, mission_expires_at: missionExpiresAt, ...(current.targetSite === 'wefunder' ? { target_label: 'WeFunder' as const } : {}) };
  }
  private async bound(selector: string, proof: string, allowExpired = false): Promise<{ hash: string; row: DaytonaViewerTicket }> {
    if (!SELECTOR.test(selector) || !TOKEN.test(proof)) fail('recovery_state_missing');
    const browserHash = digest(proof), found = await this.store.loadByBrowser(selector, browserHash);
    if (!found) return fail('recovery_state_missing');
    if (found.hash.slice(0, 32) !== selector || found.ticket.browserHash !== browserHash) return fail('recovery_state_missing');
    const recoveryUntil = found.ticket.recoveryUntil;
    if (!recoveryUntil) return fail('recovery_state_missing');
    if (!allowExpired && recoveryUntil <= this.now()) return fail('mission_expired');
    return { hash: found.hash, row: found.ticket };
  }
  private receiptMatches(mission: DaytonaViewerMission | null, row: DaytonaViewerTicket): boolean {
    const receipt = mission?.humanInputReceipt;
    return Boolean(receipt && row.grantHandle && receipt.grantHandle === row.grantHandle && receipt.human_input_revoked === true
      && receipt.profile_checkpointed === true && receipt.automation_resumed === true && Number.isSafeInteger(receipt.completedAt));
  }
  private async claim(token: string, phase: DaytonaViewerPhase, next: DaytonaViewerPhase, allowExpired = false): Promise<{ hash: string; row: DaytonaViewerTicket }> {
    if (!TOKEN.test(token)) fail('recovery_state_missing');
    return this.claimHash(digest(token), phase, next, allowExpired, allowExpired);
  }
  private async claimHash(hash: string, phase: DaytonaViewerPhase, next: DaytonaViewerPhase, allowOpeningExpired = false, allowMissionExpired = false): Promise<{ hash: string; row: DaytonaViewerTicket }> {
    const current = await this.store.load(hash);
    if (!current) return fail('recovery_state_missing');
    if (current.phase !== phase) fail(current.phase === 'NEW' ? 'operation_pending' : 'operation_pending');
    if (!await this.store.ownsMissionLease(current.sessionId, hash)) fail('mission_revoked');
    if (!allowOpeningExpired && current.expiresAt <= this.now()) fail('opening_expired');
    if (!allowMissionExpired && (current.missionExpiresAt ?? current.expiresAt) <= this.now()) fail('mission_expired');
    await this.owned(current, allowOpeningExpired, allowMissionExpired);
    const row = { ...current, phase: next, version: current.version + 1 };
    if (!await this.store.transition(hash, phase, row)) fail('operation_pending');
    return { hash, row };
  }
  private async commit(hash: string, row: DaytonaViewerTicket, phase: DaytonaViewerPhase): Promise<void> {
    if (!await this.store.transition(hash, row.phase, { ...row, phase, version: row.version + 1 })) throw new Error('viewer_unavailable');
  }
  private view(grant: DaytonaViewerGrant, row: DaytonaViewerTicket): { signed_url: string; expires_at: number } {
    const expiresCap = row.grantExpiresAt ?? row.expiresAt;
    if (!UUID.test(grant.grantHandle) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= this.now() || grant.expiresAt > expiresCap
      || (row.grantHandle && (grant.grantHandle !== row.grantHandle || grant.expiresAt !== row.grantExpiresAt))) fail('desktop_unavailable');
    let url: URL; try { url = new URL(grant.url); } catch { return fail('desktop_unavailable'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('desktop_unavailable');
    return { signed_url: url.href, expires_at: grant.expiresAt };
  }
  private async mintClaim(hash: string, row: DaytonaViewerTicket): Promise<{ signed_url: string; expires_at: number }> {
    const seconds = Math.min(300, Math.floor((row.expiresAt - this.now()) / 1000));
    if (seconds < 1) fail('opening_expired');
    let grant: DaytonaViewerGrant;
    try { grant = await this.missions.getViewerGrant(row.owner, row.sessionId, row.principalHash, seconds, row.expiresAt); }
    catch { return fail('desktop_unavailable'); }
    const view = this.view(grant, row);
    row.grantHandle = grant.grantHandle; row.grantExpiresAt = grant.expiresAt;
    await this.commit(hash, row, 'EXCHANGED');
    return view;
  }
  async exchange(token: string, browserProof?: string): Promise<{ signed_url: string; expires_at: number }> {
    if (browserProof !== undefined) await this.prepare(token, browserProof);
    const { hash, row } = await this.claim(token, 'NEW', 'ISSUING');
    return this.mintClaim(hash, row);
  }
  async openPrepared(selector: string, browserProof: string): Promise<{ signed_url: string; expires_at: number }> {
    const { hash, row: bound } = await this.bound(selector, browserProof);
    if (bound.phase !== 'NEW') fail('operation_pending');
    const { row } = await this.claimHash(hash, 'NEW', 'ISSUING');
    return this.mintClaim(hash, row);
  }
  async recover(selector: string, browserProof: string): Promise<{ signed_url: string; expires_at: number }> {
    const { hash, row } = await this.bound(selector, browserProof);
    if (!['ISSUING', 'EXCHANGED', 'RESUMING', 'RENEWING'].includes(row.phase)) fail(row.phase === 'NEW' ? 'operation_pending' : 'recovery_state_missing');
    if (!await this.store.ownsMissionLease(row.sessionId, hash)) fail('mission_revoked');
    const mission = await this.missions.loadSession(row.sessionId);
    if (!mission) return fail('recovery_state_missing');
    if (mission.sessionId !== row.sessionId || mission.owner !== row.owner || mission.ownerSubjectHash !== row.principalHash) return fail('recovery_state_missing');
    if (mission.phase !== 'ACTIVE') return fail('mission_revoked');
    if (mission.effectUnknown || !mission.viewerGrantHandle || mission.expiresAt <= this.now()) return fail('operation_pending');
    if (row.grantHandle && row.phase === 'EXCHANGED' && mission.viewerGrantHandle !== row.grantHandle) return fail('operation_pending');
    const persistedHandle = mission.viewerGrantHandle;
    const grant = await this.missions.resumeViewerGrant(row.owner, row.sessionId, row.principalHash, persistedHandle);
    if (grant.expiresAt > mission.expiresAt) fail('desktop_unavailable');
    const reconciled = { ...row, grantHandle: grant.grantHandle, grantExpiresAt: grant.expiresAt };
    const view = this.view(grant, reconciled);
    if (row.phase !== 'EXCHANGED' || row.grantHandle !== grant.grantHandle || row.grantExpiresAt !== grant.expiresAt) {
      const expected = row.phase;
      if (!await this.store.transition(hash, expected, { ...reconciled, phase: 'EXCHANGED', version: row.version + 1 })) {
        const latest = await this.store.load(hash);
        if (!latest || latest.phase !== 'EXCHANGED' || latest.grantHandle !== grant.grantHandle) throw new Error('viewer_unavailable');
      }
    }
    return view;
  }
  async status(selector: string, browserProof: string): Promise<{ status: 'ready_for_open' | 'pending' | 'active' | 'saved' | 'expired'; opening_expires_at: number; mission_expires_at: number; target_label?: 'WeFunder'; viewer_expires_at?: number; renewal_allowed?: boolean; cleanup_required?: boolean; reason?: DaytonaViewerFailure }> {
    const { hash, row } = await this.bound(selector, browserProof, true);
    const target = row.targetSite === 'wefunder' ? { target_label: 'WeFunder' as const } : {};
    const mission = await this.missions.loadSession(row.sessionId);
    if (!mission || mission.sessionId !== row.sessionId || mission.owner !== row.owner || mission.ownerSubjectHash !== row.principalHash) throw new Error('viewer_unavailable');
    const missionExpiresAt = row.missionExpiresAt ?? row.expiresAt;
    if (mission.phase === 'CLOSED' && !mission.effectUnknown && mission.profileLeaseReleased === true && this.receiptMatches(mission, row) && ['COMPLETING', 'SAVED'].includes(row.phase)) {
      if (row.phase === 'COMPLETING') {
        if (!await this.store.transition(hash, 'COMPLETING', { ...row, phase: 'SAVED', version: row.version + 1 })) {
          const latest = await this.store.load(hash); if (latest?.phase !== 'SAVED' || !this.receiptMatches(mission, latest)) return { status: 'pending', opening_expires_at: row.expiresAt, mission_expires_at: missionExpiresAt, reason: 'operation_pending' };
        }
      }
      await this.store.releaseMissionLease(row.sessionId, hash);
      return { status: 'saved', opening_expires_at: row.expiresAt, mission_expires_at: missionExpiresAt, ...target };
    }
    if (row.phase === 'COMPLETING' && mission.phase === 'ACTIVE' && !mission.effectUnknown && this.receiptMatches(mission, row)) {
      return { status: 'pending', opening_expires_at: row.expiresAt, mission_expires_at: missionExpiresAt, ...target, cleanup_required: true };
    }
    if (row.phase === 'COMPLETING' && mission.phase === 'CLOSED' && !mission.effectUnknown && this.receiptMatches(mission, row)) {
      return { status: 'pending', opening_expires_at: row.expiresAt, mission_expires_at: missionExpiresAt, ...target, cleanup_required: true };
    }
    if (row.phase === 'EXPIRING' || row.phase === 'EXPIRED') {
      if (mission.phase === 'CLOSED' && !mission.effectUnknown && mission.profileLeaseReleased === true) {
        if (row.phase === 'EXPIRING' && !await this.store.transition(hash, 'EXPIRING', { ...row, phase: 'EXPIRED', version: row.version + 1 })) {
          const latest = await this.store.load(hash); if (latest?.phase !== 'EXPIRED') return { status: 'pending', opening_expires_at: row.expiresAt, mission_expires_at: missionExpiresAt, ...target, reason: 'operation_pending' };
        }
        await this.store.releaseMissionLease(row.sessionId, hash);
        return { status: 'expired', opening_expires_at: row.expiresAt, mission_expires_at: missionExpiresAt, ...target };
      }
    }
    if (mission.phase === 'CLOSED' && !mission.effectUnknown && mission.profileLeaseReleased === true) return { status: 'expired', opening_expires_at: row.expiresAt, mission_expires_at: missionExpiresAt, ...target, reason: 'mission_revoked' };
    if (row.phase === 'NEW' && mission.phase === 'ACTIVE' && !mission.effectUnknown && row.expiresAt > this.now()) return { status: 'ready_for_open', opening_expires_at: row.expiresAt, mission_expires_at: missionExpiresAt, ...target };
    if (row.phase === 'EXCHANGED' && mission.phase === 'ACTIVE' && !mission.effectUnknown && mission.viewerGrantHandle === row.grantHandle) {
      const expired = (row.grantExpiresAt ?? 0) <= this.now();
      if (!expired) return { status: 'active', opening_expires_at: row.expiresAt, mission_expires_at: missionExpiresAt, ...target, viewer_expires_at: row.grantExpiresAt, renewal_allowed: false };
      if (missionExpiresAt > this.now() && (row.recoveryUntil ?? 0) > this.now()) return { status: 'pending', opening_expires_at: row.expiresAt, mission_expires_at: missionExpiresAt, ...target, viewer_expires_at: row.grantExpiresAt, renewal_allowed: true };
    }
    return { status: 'pending', opening_expires_at: row.expiresAt, mission_expires_at: missionExpiresAt, ...target,
      ...(row.phase === 'NEW' && row.expiresAt <= this.now() ? { reason: 'opening_expired' as const } : {}),
      ...(missionExpiresAt <= this.now() ? { reason: 'mission_expired' as const } : {}),
      ...(row.phase === 'EXCHANGED' && row.grantExpiresAt ? { viewer_expires_at: row.grantExpiresAt } : {}) };
  }
  async renew(selector: string, browserProof: string): Promise<{ signed_url: string; expires_at: number }> {
    const { hash, row } = await this.bound(selector, browserProof);
    if (row.phase !== 'EXCHANGED') return fail('operation_pending');
    const previousHandle = row.grantHandle;
    if (!previousHandle) return fail('operation_pending');
    if (!await this.store.ownsMissionLease(row.sessionId, hash)) return fail('operation_pending');
    const missionDeadline = row.missionExpiresAt ?? row.expiresAt;
    if (missionDeadline <= this.now()) fail('mission_expired');
    const mission = await this.missions.loadSession(row.sessionId);
    if (!mission) return fail('recovery_state_missing');
    if (mission.sessionId !== row.sessionId || mission.owner !== row.owner || mission.ownerSubjectHash !== row.principalHash) return fail('recovery_state_missing');
    if (mission.phase !== 'ACTIVE') return fail('mission_revoked');
    if (mission.effectUnknown || mission.viewerGrantHandle !== row.grantHandle || mission.expiresAt !== missionDeadline) return fail('operation_pending');
    const claimed = { ...row, phase: 'RENEWING' as const, version: row.version + 1 };
    if (!await this.store.transition(hash, 'EXCHANGED', claimed)) fail('operation_pending');
    let grant: DaytonaViewerGrant;
    try { grant = await this.missions.renewViewerGrant(row.owner, row.sessionId, row.principalHash, previousHandle, missionDeadline); }
    catch { return fail('desktop_unavailable'); }
    const expiry = Math.min(grant.expiresAt, missionDeadline);
    const renewed = { ...claimed, grantHandle: grant.grantHandle, grantExpiresAt: expiry, phase: 'EXCHANGED' as const, version: claimed.version + 1 };
    const view = this.view({ ...grant, expiresAt: expiry }, renewed);
    if (!await this.store.transition(hash, 'RENEWING', renewed)) fail('operation_pending');
    return view;
  }
  async reconcile(selector: string, browserProof: string): Promise<{ status: 'saved'; human_input_revoked: true; checkpoint_saved: true; mission_released: true }> {
    const { hash, row } = await this.bound(selector, browserProof, true);
    if (row.phase !== 'COMPLETING' || !await this.store.ownsMissionLease(row.sessionId, hash)) return fail('operation_pending');
    const mission = await this.missions.loadSession(row.sessionId);
    if (!mission) return fail('recovery_state_missing');
    if (mission.sessionId !== row.sessionId || mission.owner !== row.owner || mission.ownerSubjectHash !== row.principalHash) return fail('recovery_state_missing');
    if (mission.effectUnknown) return fail('operation_pending');
    if (!this.receiptMatches(mission, row)) return fail('operation_pending');
    if (mission.phase === 'ACTIVE' || (mission.phase === 'CLOSED' && mission.profileLeaseReleased !== true)) {
      try { await this.missions.stop(row.owner, row.sessionId, row.principalHash); }
      catch { return fail('desktop_unavailable'); }
    }
    const closed = await this.missions.loadSession(row.sessionId);
    if (!closed || closed.sessionId !== row.sessionId || closed.owner !== row.owner || closed.ownerSubjectHash !== row.principalHash
      || closed.phase !== 'CLOSED' || closed.effectUnknown || closed.profileLeaseReleased !== true || !this.receiptMatches(closed, row)) return fail('operation_pending');
    if (!await this.store.transition(hash, 'COMPLETING', { ...row, phase: 'SAVED', version: row.version + 1 })) {
      const latest = await this.store.load(hash);
      if (!latest || latest.phase !== 'SAVED' || !this.receiptMatches(closed, latest)) return fail('operation_pending');
    }
    await this.store.releaseMissionLease(row.sessionId, hash);
    return { status: 'saved', human_input_revoked: true, checkpoint_saved: true, mission_released: true };
  }
  async resume(token: string): Promise<{ signed_url: string; expires_at: number }> {
    const { hash, row } = await this.claim(token, 'EXCHANGED', 'RESUMING');
    if (!row.grantHandle) throw new Error('viewer_unavailable');
    const view = this.view(await this.missions.resumeViewerGrant(row.owner, row.sessionId, row.principalHash, row.grantHandle), row);
    await this.commit(hash, row, 'EXCHANGED'); return view;
  }
  async complete(token: string, browserProof?: string): Promise<{ status: 'saved'; human_input_revoked: true; checkpoint_saved: true; mission_released: true }> {
    const located = browserProof === undefined ? (TOKEN.test(token) ? { hash: digest(token), row: await this.store.load(digest(token)) } : null) : await this.bound(token, browserProof, true);
    if (!located?.row) throw new Error('viewer_unavailable');
    const hash = located.hash, current = located.row;
    if (!current || !['EXCHANGED', 'COMPLETING'].includes(current.phase)) throw new Error('viewer_unavailable');
    const row = current.phase === 'EXCHANGED' ? await this.claimHash(hash, 'EXCHANGED', 'COMPLETING', browserProof !== undefined).then(value => value.row) : current;
    if (!await this.store.ownsMissionLease(row.sessionId, hash)) throw new Error('viewer_unavailable');
    let mission = await this.missions.loadSession(row.sessionId);
    if (!mission || mission.sessionId !== row.sessionId || mission.owner !== row.owner || mission.ownerSubjectHash !== row.principalHash) throw new Error('viewer_unavailable');
    if (!this.receiptMatches(mission, row)) {
      if (current.phase === 'COMPLETING' || row.phase !== 'COMPLETING' || mission.phase !== 'ACTIVE' || mission.effectUnknown || !row.grantHandle || mission.viewerGrantHandle !== row.grantHandle) throw new Error('viewer_unavailable');
      const receipt = await this.missions.completeHumanInput(row.owner, row.sessionId, row.principalHash);
      if (receipt?.human_input_revoked !== true || receipt.status !== 'saved' || receipt.receipt?.grantHandle !== row.grantHandle
        || receipt.receipt.profile_checkpointed !== true || receipt.receipt.automation_resumed !== true) throw new Error('viewer_unavailable');
    }
    await this.missions.stop(row.owner, row.sessionId, row.principalHash);
    mission = await this.missions.loadSession(row.sessionId);
    if (!mission || mission.phase !== 'CLOSED' || mission.effectUnknown || mission.profileLeaseReleased !== true || mission.owner !== row.owner || mission.ownerSubjectHash !== row.principalHash || !this.receiptMatches(mission, row)) throw new Error('viewer_unavailable');
    if (!await this.store.transition(hash, 'COMPLETING', { ...row, phase: 'SAVED', version: row.version + 1 })) throw new Error('viewer_unavailable');
    await this.store.releaseMissionLease(row.sessionId, hash);
    return { status: 'saved', human_input_revoked: true, checkpoint_saved: true, mission_released: true };
  }
  async expire(token: string, browserProof?: string): Promise<{ status: 'expired'; human_input_revoked: true; mission_released: true }> {
    const located = browserProof === undefined ? (TOKEN.test(token) ? { hash: digest(token), row: await this.store.load(digest(token)) } : null) : await this.bound(token, browserProof, true);
    if (!located?.row) throw new Error('viewer_unavailable');
    const hash = located.hash, current = located.row;
    if (!current || !['EXCHANGED', 'EXPIRING'].includes(current.phase)) throw new Error('viewer_unavailable');
    const row = current.phase === 'EXCHANGED' ? await this.claimHash(hash, 'EXCHANGED', 'EXPIRING', true, true).then(value => value.row) : current;
    if (!await this.store.ownsMissionLease(row.sessionId, hash)) throw new Error('viewer_unavailable');
    await this.missions.stop(row.owner, row.sessionId, row.principalHash);
    const mission = await this.missions.loadSession(row.sessionId);
    if (!mission || mission.sessionId !== row.sessionId || mission.owner !== row.owner || mission.ownerSubjectHash !== row.principalHash || mission.phase !== 'CLOSED' || mission.effectUnknown || mission.profileLeaseReleased !== true) throw new Error('viewer_unavailable');
    if (!await this.store.transition(hash, 'EXPIRING', { ...row, phase: 'EXPIRED', version: row.version + 1 })) throw new Error('viewer_unavailable');
    await this.store.releaseMissionLease(row.sessionId, hash);
    return { status: 'expired', human_input_revoked: true, mission_released: true };
  }
}

const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SELECTOR = /^[a-f0-9]{32}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Item = Record<string, { S?: string; N?: string }>;
export interface DaytonaViewerStoreOptions { tableName?: string; region?: string; now?: () => number; fetchImpl?: typeof fetch; resolveCredentials?: () => Promise<AwsCredentials | null> }
class Conflict extends Error {}
/** Only hashes, immutable ownership and opaque handles are stored; never viewer URLs/tokens. */
export class DynamoDaytonaViewerTicketStore implements DaytonaViewerTicketStore {
  private readonly table: string; private readonly region: string;
  constructor(private readonly options: DaytonaViewerStoreOptions = {}) {
    this.table = options.tableName ?? process.env.CLOUD_BROWSER_DDB_TABLE ?? 'otchealth-browser-cloud'; this.region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(this.table) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(this.region)) throw new Error('viewer_store_unavailable');
  }
  private key(kind: 'TICKET' | 'LEASE', value: string): string { if (typeof value !== 'string' || !(kind === 'TICKET' ? HASH : ID).test(value)) throw new Error('viewer_store_unavailable'); return `DAYTONA_VIEWER#${kind}#${value}`; }
  private async call(operation: string, payload: Record<string, unknown>): Promise<{ Item?: Item; CancellationReasons?: Array<{ Code?: string }> }> {
    try {
      const credentials = await (this.options.resolveCredentials ?? resolveAwsCredentials)(); if (!credentials) throw new Error();
      const host = `dynamodb.${this.region}.amazonaws.com`, body = JSON.stringify(operation === 'TransactWriteItems' ? payload : { TableName: this.table, ...payload });
      const signed = signRequest({ method: 'POST', host, path: '/', body, region: this.region, service: 'dynamodb', credentials, extraHeaders: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${operation}` } });
      const response = await (this.options.fetchImpl ?? fetch)(`https://${host}/`, { method: 'POST', headers: signed.headers, body, redirect: 'error', signal: AbortSignal.timeout(5000) });
      const result = await response.json() as { Item?: Item; __type?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (!response.ok) {
        if (result.__type?.endsWith('ConditionalCheckFailedException')) throw new Conflict();
        if (result.__type?.endsWith('TransactionCanceledException') && result.CancellationReasons?.length
          && result.CancellationReasons.every(reason => !reason.Code || reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed')) throw new Conflict();
        throw new Error();
      }
      return result;
    } catch (error) { if (error instanceof Conflict) throw error; throw new Error('viewer_store_unavailable'); }
  }
  private checked(row: DaytonaViewerTicket): void {
    const fields = ['owner', 'principalHash', 'sessionId', 'expiresAt', 'phase', 'version', 'targetSite', 'grantHandle', 'grantExpiresAt', 'missionExpiresAt', 'browserHash', 'recoveryUntil'];
    if (!row || Object.keys(row).some(key => !fields.includes(key)) || typeof row.owner !== 'string' || typeof row.sessionId !== 'string' || typeof row.principalHash !== 'string' || !ID.test(row.owner) || !ID.test(row.sessionId) || !HASH.test(row.principalHash)
      || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0 || !Number.isSafeInteger(row.version) || row.version < 0
      || (row.targetSite !== undefined && row.targetSite !== 'wefunder')
      || !['NEW','ISSUING','EXCHANGED','RESUMING','RENEWING','COMPLETING','EXPIRING','SAVED','EXPIRED'].includes(row.phase)
      || (row.missionExpiresAt !== undefined && (!Number.isSafeInteger(row.missionExpiresAt) || row.missionExpiresAt < row.expiresAt))
      || ((row.browserHash === undefined) !== (row.recoveryUntil === undefined))
      || (row.browserHash !== undefined && (!HASH.test(row.browserHash) || !Number.isSafeInteger(row.recoveryUntil) || row.recoveryUntil! <= 0 || row.recoveryUntil! > (row.missionExpiresAt ?? row.expiresAt)))
      || ((row.grantHandle === undefined) !== (row.grantExpiresAt === undefined))
      || (row.grantHandle !== undefined && (typeof row.grantHandle !== 'string' || !UUID.test(row.grantHandle) || !Number.isSafeInteger(row.grantExpiresAt) || row.grantExpiresAt! <= 0 || row.grantExpiresAt! > (row.missionExpiresAt ?? row.expiresAt)))) throw new Error('viewer_store_unavailable');
  }
  async create(hash: string, row: DaytonaViewerTicket): Promise<boolean> {
    this.checked(row);
    // Retain reconciliation receipts with their permanent owner fence. Access
    // still expires at row.expiresAt; metadata retention never renews a ticket.
    try { await this.call('PutItem', { Item: { pk: { S: this.key('TICKET', hash) }, payload: { S: JSON.stringify(row) }, phase: { S: row.phase }, version: { N: String(row.version) } }, ConditionExpression: 'attribute_not_exists(pk)' }); return true; } catch (error) { if (error instanceof Conflict) return false; throw error; }
  }
  async load(hash: string): Promise<DaytonaViewerTicket | null> {
    const pk = this.key('TICKET', hash), result = await this.call('GetItem', { Key: { pk: { S: pk } }, ConsistentRead: true });
    if (!result.Item) return null;
    if (result.Item.pk?.S !== pk || typeof result.Item.payload?.S !== 'string') throw new Error('viewer_store_unavailable');
    let row: DaytonaViewerTicket; try { row = JSON.parse(result.Item.payload.S) as DaytonaViewerTicket; } catch { throw new Error('viewer_store_unavailable'); }
    this.checked(row); if (result.Item.phase?.S !== row.phase || Number(result.Item.version?.N) !== row.version) throw new Error('viewer_store_unavailable'); return row;
  }
  async transition(hash: string, phase: DaytonaViewerPhase, next: DaytonaViewerTicket): Promise<boolean> {
    this.checked(next);
    try { await this.call('UpdateItem', { Key: { pk: { S: this.key('TICKET', hash) } }, UpdateExpression: 'SET payload = :payload, #phase = :next, #version = :nextVersion', ConditionExpression: '#phase = :old AND #version = :oldVersion', ExpressionAttributeNames: { '#phase': 'phase', '#version': 'version' }, ExpressionAttributeValues: { ':payload': { S: JSON.stringify(next) }, ':next': { S: next.phase }, ':old': { S: phase }, ':nextVersion': { N: String(next.version) }, ':oldVersion': { N: String(next.version - 1) } } }); return true; } catch (error) { if (error instanceof Conflict) return false; throw error; }
  }
  async acquireMissionLease(id: string, hash: string): Promise<boolean> {
    if (!HASH.test(hash)) throw new Error('viewer_store_unavailable');
    // No time-based takeover of an unknown human-input effect. Only confirmed
    // revocation or exact operator reconciliation can release this owner fence.
    try { await this.call('PutItem', { Item: { pk: { S: this.key('LEASE', id) }, owner: { S: hash } }, ConditionExpression: 'attribute_not_exists(pk)' }); return true; } catch (error) { if (error instanceof Conflict) return false; throw error; }
  }
  async ownsMissionLease(id: string, hash: string): Promise<boolean> { const pk = this.key('LEASE', id), result = await this.call('GetItem', { Key: { pk: { S: pk } }, ConsistentRead: true }); return result.Item?.pk?.S === pk && result.Item.owner?.S === hash; }
  async releaseMissionLease(id: string, hash: string): Promise<void> {
    if (!HASH.test(hash)) throw new Error('viewer_store_unavailable');
    try { await this.call('DeleteItem', { Key: { pk: { S: this.key('LEASE', id) } }, ConditionExpression: '#owner = :owner', ExpressionAttributeNames: { '#owner': 'owner' }, ExpressionAttributeValues: { ':owner': { S: hash } } }); } catch (error) { if (!(error instanceof Conflict)) throw error; }
  }
  async bindBrowser(hash: string, selector: string, browserHash: string, recoveryUntil: number, next: DaytonaViewerTicket): Promise<boolean> {
    this.checked(next);
    if (!HASH.test(hash) || !SELECTOR.test(selector) || hash.slice(0, 32) !== selector || !HASH.test(browserHash)
      || next.browserHash !== browserHash || next.recoveryUntil !== recoveryUntil) throw new Error('viewer_store_unavailable');
    const pointer = `DAYTONA_VIEWER#RECOVERY#${browserHash}#${selector}`;
    try {
      await this.call('TransactWriteItems', { TransactItems: [
        { Update: { TableName: this.table, Key: { pk: { S: this.key('TICKET', hash) } }, UpdateExpression: 'SET payload = :payload, #version = :nextVersion, browserHash = :browserHash', ConditionExpression: '#phase IN (:new, :exchanged) AND #version = :oldVersion AND (attribute_not_exists(browserHash) OR browserHash = :browserHash)', ExpressionAttributeNames: { '#phase': 'phase', '#version': 'version' }, ExpressionAttributeValues: { ':payload': { S: JSON.stringify(next) }, ':new': { S: 'NEW' }, ':exchanged': { S: 'EXCHANGED' }, ':oldVersion': { N: String(next.version - (next.version === 0 ? 0 : 1)) }, ':nextVersion': { N: String(next.version) }, ':browserHash': { S: browserHash } } } },
        { Put: { TableName: this.table, Item: { pk: { S: pointer }, payload: { S: hash } }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ] }); return true;
    } catch (error) {
      if (error instanceof Conflict) {
        const existing = await this.load(hash);
        if (existing?.browserHash === browserHash && existing.recoveryUntil === recoveryUntil && existing.version === next.version) return true;
        return false;
      }
      throw error;
    }
  }
  async loadByBrowser(selector: string, browserHash: string): Promise<{ hash: string; ticket: DaytonaViewerTicket } | null> {
    if (!SELECTOR.test(selector) || !HASH.test(browserHash)) throw new Error('viewer_store_unavailable');
    const pk = `DAYTONA_VIEWER#RECOVERY#${browserHash}#${selector}`;
    const result = await this.call('GetItem', { Key: { pk: { S: pk } }, ConsistentRead: true });
    if (!result.Item) return null;
    const hash = result.Item.payload?.S;
    if (result.Item.pk?.S !== pk || typeof hash !== 'string' || !HASH.test(hash) || hash.slice(0, 32) !== selector) throw new Error('viewer_store_unavailable');
    const ticket = await this.load(hash);
    if (!ticket || ticket.browserHash !== browserHash) throw new Error('viewer_store_unavailable');
    return { hash, ticket };
  }
}

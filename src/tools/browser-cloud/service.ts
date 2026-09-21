import { randomUUID } from 'node:crypto';
import {
  CLOUD_BROWSER_DAILY_SESSION_LIMIT, CLOUD_BROWSER_MAX_ACTIONS, CLOUD_BROWSER_MAX_ACTION_SECONDS, CLOUD_BROWSER_MAX_SESSION_SECONDS,
  type CloudBrowserAction, type CloudBrowserObservation, type CloudBrowserProfile, type CloudBrowserSession, type CloudBrowserStore,
  type CloudBrowserTransport, CloudBrowserError,
} from './contract.js';

function validHost(host: string): boolean { return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(host); }

/**
 * These are the ordinary company Chat lanes that may receive an isolated public
 * trial profile. The protected personal-legal lane is deliberately absent.
 */
export const CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS = [
  'cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director',
] as const;

export type CloudBrowserPublicTrialOwner = (typeof CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS)[number];

export function publicTrialProfileId(owner: CloudBrowserPublicTrialOwner): string {
  return `${owner}-public-trial`;
}

function isPublicTrialOwner(owner: string): owner is CloudBrowserPublicTrialOwner {
  return (CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS as readonly string[]).includes(owner);
}

function assertProfile(profile: CloudBrowserProfile): void {
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/i.test(profile.profileId) || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(profile.owner)) throw new CloudBrowserError('invalid_profile', 'Profile identity is invalid.');
  if (profile.allowedHosts.length === 0 || profile.allowedHosts.length > 24 || profile.allowedHosts.some((host) => !validHost(host))) throw new CloudBrowserError('invalid_profile', 'Profile hosts are invalid.');
}

function assertAction(action: CloudBrowserAction, hosts: readonly string[]): void {
  if (action.type === 'navigate') {
    let url: URL;
    try { url = new URL(action.url); } catch { throw new CloudBrowserError('invalid_action', 'Navigation URL is invalid.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname.toLowerCase())) throw new CloudBrowserError('host_forbidden', 'Navigation host is not allowed for this profile.');
    return;
  }
  if (action.type === 'snapshot') return;
  const selector = action.selector;
  if (selector.length === 0 || selector.length > 256 || /[\r\n]/.test(selector)) throw new CloudBrowserError('invalid_action', 'Selector is invalid.');
  if (action.type === 'type' && (action.text.length > 1_024 || /[\u0000-\u001f]/.test(action.text))) throw new CloudBrowserError('invalid_action', 'Text input is invalid.');
}

function assertObservationHost(observation: CloudBrowserObservation | null, hosts: readonly string[]): void {
  if (!observation?.url) throw new CloudBrowserError('provider_observation_invalid', 'Browser provider did not return a current page URL.');
  let url: URL;
  try { url = new URL(observation.url); } catch { throw new CloudBrowserError('redirect_outside_allowlist', 'Browser navigation ended outside the enrolled host policy.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname.toLowerCase())) throw new CloudBrowserError('redirect_outside_allowlist', 'Browser navigation ended outside the enrolled host policy.');
}

/** Durable session orchestration. Caller binding is checked before every store or provider action. */
export class CloudBrowserService {
  constructor(private readonly store: CloudBrowserStore, private readonly transport: CloudBrowserTransport, private readonly now: () => number = Date.now) {}

  async saveProfile(caller: string, profile: CloudBrowserProfile): Promise<void> {
    assertProfile(profile);
    if (caller !== profile.owner) throw new CloudBrowserError('owner_forbidden', 'A profile can only be saved by its owner.');
    await this.store.saveProfile({ ...profile, allowedHosts: [...new Set(profile.allowedHosts.map((host) => host.toLowerCase()))] });
  }

  async loadProfile(caller: string, profileId: string): Promise<CloudBrowserProfile> {
    const profile = await this.store.loadProfile(profileId);
    if (!profile || profile.owner !== caller) throw new CloudBrowserError('owner_forbidden', 'Profile is unavailable to this caller.');
    return profile;
  }

  /**
   * Returns the one deterministic profile name a Chat lane may use. This avoids
   * profile-ID guessing while never enumerating another lane's profiles.
   */
  async publicTrialProfile(caller: string): Promise<Pick<CloudBrowserProfile, 'profileId' | 'allowedHosts' | 'persistent'>> {
    if (!isPublicTrialOwner(caller)) throw new CloudBrowserError('profile_not_enrolled', 'This caller has no cloud-browser public trial profile.');
    const profile = await this.loadProfile(caller, publicTrialProfileId(caller));
    return { profileId: profile.profileId, allowedHosts: profile.allowedHosts, persistent: profile.persistent };
  }

  /**
   * CTO provisions a public, non-persistent profile for one ordinary Chat lane.
   * The target owner is fixed from the allowlist and can never be the protected
   * personal-legal lane. Existing profiles retain their original owner because
   * the store's conditional write rejects ownership changes.
   */
  async provisionPublicTrialProfile(caller: string, owner: string, allowedHosts: readonly string[]): Promise<Pick<CloudBrowserProfile, 'profileId' | 'owner' | 'allowedHosts' | 'persistent'>> {
    if (caller !== 'cto') throw new CloudBrowserError('provisioner_forbidden', 'Only the CTO lane may provision a public trial profile.');
    if (!isPublicTrialOwner(owner)) throw new CloudBrowserError('profile_owner_not_allowed', 'The requested profile owner is not eligible for a public trial profile.');
    const profile: CloudBrowserProfile = { profileId: publicTrialProfileId(owner), owner, allowedHosts, persistent: false };
    assertProfile(profile);
    await this.store.saveProfile({ ...profile, allowedHosts: [...new Set(profile.allowedHosts.map((host) => host.toLowerCase()))] });
    return { profileId: profile.profileId, owner: profile.owner, allowedHosts: profile.allowedHosts.map((host) => host.toLowerCase()), persistent: false };
  }

  async start(caller: string, profileId: string, maxSeconds: number): Promise<{ sessionId: string; expiresAt: number }> {
    if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > CLOUD_BROWSER_MAX_SESSION_SECONDS) throw new CloudBrowserError('invalid_duration', 'Session duration exceeds the cloud-browser bound.');
    const profile = await this.loadProfile(caller, profileId);
    const lockOwner = `${caller}:${randomUUID()}`;
    if (!await this.store.acquireProfileLock(profileId, lockOwner, this.now() + 30_000)) throw new CloudBrowserError('profile_busy', 'Another browser session operation is in progress for this profile.');
    if (!await this.store.reserveDailySession(caller, new Date(this.now()).toISOString().slice(0, 10), CLOUD_BROWSER_DAILY_SESSION_LIMIT)) { await this.store.releaseProfileLock(profileId, lockOwner); throw new CloudBrowserError('daily_session_limit', 'The daily cloud-browser session limit has been reached.'); }
    let remote: Pick<CloudBrowserSession, 'providerSessionId' | 'automationEndpoint'>;
    try { remote = await this.transport.start({ owner: caller, profile, maxSeconds }); } finally { await this.store.releaseProfileLock(profileId, lockOwner); }
    const session: CloudBrowserSession = {
      sessionId: randomUUID(), owner: caller, profileId: profile.profileId, allowedHosts: profile.allowedHosts,
      expiresAt: this.now() + maxSeconds * 1_000, actionsUsed: 0, ...remote,
    };
    try { await this.store.saveSession(session); }
    catch (error) { await this.transport.stop(session).catch(() => undefined); throw error; }
    return { sessionId: session.sessionId, expiresAt: session.expiresAt };
  }

  async execute(caller: string, sessionId: string, action: CloudBrowserAction, timeoutSeconds: number): Promise<CloudBrowserObservation | null> {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > CLOUD_BROWSER_MAX_ACTION_SECONDS) throw new CloudBrowserError('invalid_duration', 'Action duration exceeds the cloud-browser bound.');
    const session = await this.sessionFor(caller, sessionId);
    if (session.actionsUsed >= CLOUD_BROWSER_MAX_ACTIONS) throw new CloudBrowserError('action_limit', 'Session action limit reached.');
    assertAction(action, session.allowedHosts);
    const lockOwner = `${caller}:${randomUUID()}`;
    if (!await this.store.acquireSessionLock(sessionId, lockOwner, this.now() + (timeoutSeconds + 5) * 1_000)) throw new CloudBrowserError('session_busy', 'Another bounded browser action is in progress for this session.');
    try {
      const current = await this.sessionFor(caller, sessionId);
      if (current.actionsUsed >= CLOUD_BROWSER_MAX_ACTIONS) throw new CloudBrowserError('action_limit', 'Session action limit reached.');
      const deadline = this.now() + Math.min(timeoutSeconds, Math.max(1, Math.ceil((current.expiresAt - this.now()) / 1_000))) * 1_000;
      const remainingSeconds = (): number => Math.max(0, Math.ceil((deadline - this.now()) / 1_000));
      const checkCurrentPage = async (): Promise<CloudBrowserObservation> => {
        const remaining = remainingSeconds();
        if (remaining <= 0) throw new CloudBrowserError('provider_timeout', 'Browser action exceeded its bounded deadline.');
        const page = await this.transport.execute(current, { type: 'snapshot' }, remaining);
        assertObservationHost(page, current.allowedHosts);
        return page as CloudBrowserObservation;
      };
      if (action.type !== 'navigate') await checkCurrentPage();
      let observation: CloudBrowserObservation | null;
      if (action.type !== 'wait_for') observation = await this.transport.execute(current, action, remainingSeconds());
      else {
        for (;;) {
          if (remainingSeconds() <= 0) throw new CloudBrowserError('provider_timeout', 'Browser wait action exceeded its bounded deadline.');
          try { observation = await this.transport.execute(current, action, remainingSeconds()); break; }
          catch (error) { if (!(error instanceof CloudBrowserError) || error.code !== 'selector_not_found') throw error; await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, deadline - this.now())))); }
        }
      }
      const currentPage = action.type === 'snapshot' ? observation : await checkCurrentPage();
      assertObservationHost(currentPage, current.allowedHosts);
      await this.store.saveSessionUnderLock({ ...current, actionsUsed: current.actionsUsed + 1 }, lockOwner);
      return action.type === 'snapshot' ? currentPage : observation;
    } finally { await this.store.releaseSessionLock(sessionId, lockOwner); }
  }

  /** Returns only a bounded accessibility observation, never DOM, screenshot, cookies, or endpoint. */
  async snapshot(caller: string, sessionId: string): Promise<CloudBrowserObservation> {
    const result = await this.execute(caller, sessionId, { type: 'snapshot' }, 10);
    if (!result) throw new CloudBrowserError('provider_observation_invalid', 'Browser provider did not return an observation.');
    return result;
  }

  async stop(caller: string, sessionId: string): Promise<void> {
    const session = await this.sessionFor(caller, sessionId, true); const lockOwner = `${caller}:${randomUUID()}`;
    if (!await this.store.acquireSessionLock(sessionId, lockOwner, this.now() + 25_000)) throw new CloudBrowserError('session_busy', 'Another bounded browser action is in progress for this session.');
    try { await this.transport.stop(session); await this.store.deleteSession(sessionId); } finally { await this.store.releaseSessionLock(sessionId, lockOwner); }
  }

  async savePersistentProfile(caller: string, sessionId: string): Promise<void> {
    const session = await this.sessionFor(caller, sessionId);
    const profile = await this.loadProfile(caller, session.profileId);
    if (!profile.persistent || !profile.providerProfileId || !this.transport.saveProfile) throw new CloudBrowserError('profile_not_persistent', 'This session has no provider-backed persistent profile.');
    const lockOwner = `${caller}:${randomUUID()}`;
    if (!await this.store.acquireProfileLock(profile.profileId, lockOwner, this.now() + 30_000)) throw new CloudBrowserError('profile_busy', 'Another browser session operation is in progress for this profile.');
    try { await this.transport.saveProfile(session, profile); } finally { await this.store.releaseProfileLock(profile.profileId, lockOwner); }
  }

  private async sessionFor(caller: string, sessionId: string, allowExpired = false): Promise<CloudBrowserSession> {
    const session = await this.store.loadSession(sessionId);
    if (!session || session.owner !== caller) throw new CloudBrowserError('owner_forbidden', 'Session is unavailable to this caller.');
    if (!allowExpired && session.expiresAt <= this.now()) throw new CloudBrowserError('session_expired', 'Session expired and must be stopped before a new session starts.');
    return session;
  }
}

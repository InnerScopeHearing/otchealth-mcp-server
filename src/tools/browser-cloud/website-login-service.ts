import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CloudBrowserError, type CloudBrowserStore, type CloudBrowserSession } from './contract.js';
import { CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS, type CloudBrowserService } from './service.js';
import type { AgentCoreCloudBrowserTransport } from './agentcore-transport.js';
import type { IntercomProfileProvider } from './intercom-profile-provider.js';
import type { WebsiteLoginSite, WebsiteLoginBinding, WebsiteLoginTicketStore } from './website-login-store.js';
import { assertWebsiteLoginTargetPublic, validateWebsiteLoginTarget, type WebsiteLoginTarget } from './website-login-policy.js';

export { WEBSITE_LOGIN_SITES, type WebsiteLoginSite } from './website-login-store.js';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenValid = (value: string) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
// These codes originate only before CloudBrowserService.start calls its transport.
// Credential/store errors are deliberately absent: the same codes can also occur
// while persisting a session after the remote provider has already created it.
const PRE_START_REJECTIONS = new Set([
  'principal_binding_invalid', 'owner_forbidden', 'profile_login_in_progress',
  'invalid_profile', 'profile_state_invalid', 'invalid_duration', 'invalid_action_budget',
  'profile_busy', 'daily_session_limit',
]);
function checkedOwner(owner: string): void {
  if (!(CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS as readonly string[]).includes(owner)) throw new CloudBrowserError('owner_forbidden', 'Use an eligible authenticated company connection.');
}
export function websitePrincipalHash(owner: string, key: string | undefined): string {
  checkedOwner(owner);
  if (typeof key !== 'string' || !key || key.length > 4096) throw new CloudBrowserError('oauth_subject_required', 'Use the authenticated company connection.');
  // Retains the existing COO/Intercom principal scheme for lifecycle compatibility.
  return digest(`${owner}\0${key}`);
}
export function websiteLoginPolicy(site: WebsiteLoginSite, target?: WebsiteLoginTarget): { label: string; host: string; loginUrl: string; signedInPath: RegExp; allowedHosts: readonly string[]; target?: WebsiteLoginTarget } {
  if (site === 'custom') {
    const checked = validateWebsiteLoginTarget(target);
    const host = new URL(checked.origin).hostname;
    return { label: host, host, loginUrl: `${checked.origin}${checked.expectedPathname}`, signedInPath: new RegExp(`^${checked.expectedPathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), allowedHosts: checked.allowedHosts, target: checked };
  }
  if (target !== undefined) throw new CloudBrowserError('website_target_invalid', 'Use the saved website destination for this sign-in.');
  if (site === 'wefunder') return { label: 'WeFunder', host: 'wefunder.com', loginUrl: 'https://wefunder.com/otchealth/editor', signedInPath: /^\/otchealth\/editor(?:\/|$)/, allowedHosts: ['wefunder.com'] };
  if (site === 'linkedin') return { label: 'LinkedIn', host: 'www.linkedin.com', loginUrl: 'https://www.linkedin.com/feed/', signedInPath: /^\/(?:feed(?:\/|$)|in\/[^/]+\/?$)/, allowedHosts: ['www.linkedin.com'] };
  throw new CloudBrowserError('website_not_supported', 'Choose a supported company website.');
}
export function websiteProfileId(owner: string, hash: string, site: WebsiteLoginSite, target?: WebsiteLoginTarget): string {
  checkedOwner(owner); const policy = websiteLoginPolicy(site, target);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new CloudBrowserError('principal_binding_invalid', 'The company connection is invalid.');
  return `web-${owner}-${site}-${digest(`${hash}\0${policy.target?.siteKey ?? site}`).slice(0, 20)}`;
}
const sameHosts = (actual: readonly string[], expected: readonly string[]) => actual.length === expected.length && actual.every((host, index) => host === expected[index]);

/** Owner-selected public websites reuse the deployed Intercom human-login provider boundary. */
export class WebsiteLoginService {
  constructor(private readonly store: CloudBrowserStore, private readonly browser: CloudBrowserService,
    private readonly transport: AgentCoreCloudBrowserTransport, private readonly provider: IntercomProfileProvider,
    private readonly tickets: WebsiteLoginTicketStore, private readonly now: () => number = Date.now,
    private readonly assertPublic: (target: WebsiteLoginTarget) => Promise<void> = assertWebsiteLoginTargetPublic) {}
  async discover(owner: string, key: string | undefined, site: WebsiteLoginSite, target?: WebsiteLoginTarget): Promise<{ profile_id: string; persistent: true; allowed_hosts: readonly string[] }> {
    const hash = websitePrincipalHash(owner, key);
    const policy = websiteLoginPolicy(site, target);
    const profileId = websiteProfileId(owner, hash, site, policy.target);
    const profile = await this.store.loadProfile(profileId);
    if (!profile || !profile.providerProfileId) throw new CloudBrowserError('profile_not_enrolled', 'This website has no saved browser profile for this connection.');
    if (profile.owner !== owner || profile.ownerSubjectHash !== hash || profile.mode === 'public_web' || !profile.persistent || !sameHosts(profile.allowedHosts, policy.allowedHosts)) throw new CloudBrowserError('owner_forbidden', 'The website profile is unavailable to this connection.');
    return { profile_id: profileId, persistent: true, allowed_hosts: [...profile.allowedHosts] };
  }
  async start(owner: string, key: string | undefined, site: WebsiteLoginSite, target?: WebsiteLoginTarget): Promise<{ login_url: string; profile_id: string; session_id: string; expires_at: number; status: 'human_login_required' }> {
    const hash = websitePrincipalHash(owner, key);
    const policy = websiteLoginPolicy(site, target);
    if (policy.target) await this.assertPublic(policy.target);
    const profileId = websiteProfileId(owner, hash, site, policy.target);
    const profileLeaseOwner = randomUUID();
    if (!await this.tickets.acquireProfileLease(profileId, profileLeaseOwner, this.now() + 3_630_000)) throw new CloudBrowserError('profile_busy', 'A human sign-in or profile save is already in progress for this website.');
    let sessionId: string | undefined;
    let retainLease = false;
    try {
      let profile = await this.store.loadProfile(profileId);
      if (profile && (profile.owner !== owner || profile.ownerSubjectHash !== hash || profile.mode === 'public_web' || !profile.persistent || !sameHosts(profile.allowedHosts, policy.allowedHosts))) throw new CloudBrowserError('owner_forbidden', 'The website profile is unavailable to this connection.');
      if (profile && !profile.providerProfileId) throw new CloudBrowserError('profile_preparation_unknown', 'The prior profile preparation needs operator reconciliation.');
      if (!profile) {
        profile = { profileId, owner, ownerSubjectHash: hash, allowedHosts: [...policy.allowedHosts], persistent: true, actionBudget: 10_000, maxSessionSeconds: 28_800, maxActionSeconds: 120 };
        if (!this.store.createProfileIntent || !await this.store.createProfileIntent(profile)) throw new CloudBrowserError('profile_preparation_unknown', 'Profile preparation is already pending.');
        const name = `companyWebsiteAuth_${profileId.slice(-20)}`;
        const created = await this.provider.createProfile({ name, clientToken: digest(profileId), ownerSubjectHash: hash });
        if (!created.providerProfileId.startsWith(`${name}-`)) throw new CloudBrowserError('profile_create_invalid', 'The provider profile identity did not match its owned name.');
        profile = { ...profile, providerProfileId: created.providerProfileId };
        await this.browser.saveProfile(owner, profile, hash);
      }
      // A lost start acknowledgement may leave a real provider session. Preserve its lease.
      retainLease = true;
      const started = await this.browser.start(owner, profileId, 3600, undefined, hash, profileLeaseOwner);
      sessionId = started.sessionId;
      await this.browser.beginSensitiveOutputSuppression(owner, started.sessionId, hash);
      const session = await this.ownedSession({ owner, ownerSubjectHash: hash, profileId, sessionId: started.sessionId, site, ...(policy.target ? { target: policy.target } : {}), profileLeaseOwner, expiresAt: this.now() + 600_000 });
      await this.transport.prepareWebsiteLogin(session, site, policy.target);
      await this.store.saveSession(session);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = this.now() + 600_000;
      await this.tickets.create({ tokenHash: digest(token), owner, ownerSubjectHash: hash, profileId, sessionId: started.sessionId, site, ...(policy.target ? { target: policy.target } : {}), profileLeaseOwner, expiresAt });
      return { login_url: `https://mcp.otchealth.app/browser/connect#token=${token}`, profile_id: profileId, session_id: started.sessionId, expires_at: expiresAt, status: 'human_login_required' };
    } catch (error) {
      if (sessionId) { try { await this.browser.stop(owner, sessionId, hash); retainLease = false; } catch { /* ambiguous cleanup retains the lease */ } }
      else if (error instanceof CloudBrowserError && PRE_START_REJECTIONS.has(error.code)) retainLease = false;
      if (!retainLease) await this.tickets.releaseProfileLease(profileId, profileLeaseOwner).catch(() => undefined);
      throw error;
    }
  }
  async exchange(token: string): Promise<{ signed_url: string; expires_at: number; site_label: string; workspace_id: WebsiteLoginSite; status: 'login_required' }> {
    if (!tokenValid(token)) throw new CloudBrowserError('login_expired', 'This login link is invalid or expired.');
    const binding = await this.tickets.exchange(digest(token));
    if (!binding) throw new CloudBrowserError('login_expired', 'This login link is invalid, consumed or expired.');
    const session = await this.ownedSession(binding);
    const signed = await this.provider.generateLiveViewUrl({ browserIdentifier: session.providerBrowserId!, sessionId: session.providerSessionId, expiresIn: 300 });
    return { signed_url: signed.url, expires_at: Math.min(binding.expiresAt, this.now() + 300_000), site_label: websiteLoginPolicy(binding.site, binding.target).label, workspace_id: binding.site, status: 'login_required' };
  }
  async complete(token: string): Promise<{ status: 'saved'; site: WebsiteLoginSite; workspace_id: WebsiteLoginSite; verification: 'owner_confirmation_and_expected_url' }> {
    if (!tokenValid(token)) throw new CloudBrowserError('login_expired', 'The login session is invalid.');
    const hash = digest(token);
    const ticket = await this.tickets.load(hash);
    if (!ticket || ticket.phase !== 'EXCHANGED' || !await this.tickets.finish(hash)) throw new CloudBrowserError('login_expired', 'The login session is expired or already completed.');
    let confirmedStopped = false;
    try {
      const session = await this.ownedSession(ticket);
      await this.transport.verifyWebsiteLogin(session, ticket.site, ticket.target);
      await this.browser.savePersistentProfile(ticket.owner, session.sessionId, ticket.ownerSubjectHash, ticket.profileLeaseOwner);
      // Never unmask a human login session. Successful stop removes its suppressed state;
      // failed cleanup leaves suppression in force for operator reconciliation.
      await this.browser.stop(ticket.owner, session.sessionId, ticket.ownerSubjectHash);
      confirmedStopped = true;
      await this.tickets.releaseProfileLease(ticket.profileId, ticket.profileLeaseOwner);
      if (!await this.tickets.complete(hash, 'SAVED')) throw new CloudBrowserError('login_save_unknown', 'The saved sign-in receipt could not be confirmed.');
      return { status: 'saved', site: ticket.site, workspace_id: ticket.site, verification: 'owner_confirmation_and_expected_url' };
    } catch (error) {
      await this.tickets.complete(hash, 'FAILED').catch(() => undefined);
      if (!confirmedStopped) {
        try { await this.browser.stop(ticket.owner, ticket.sessionId, ticket.ownerSubjectHash); confirmedStopped = true; } catch { /* retain suppression and lease after ambiguous stop */ }
      }
      if (confirmedStopped) await this.tickets.releaseProfileLease(ticket.profileId, ticket.profileLeaseOwner).catch(() => undefined);
      throw error;
    }
  }
  private async ownedSession(binding: WebsiteLoginBinding): Promise<CloudBrowserSession> {
    checkedOwner(binding.owner); const policy = websiteLoginPolicy(binding.site, binding.target);
    if (binding.expiresAt <= this.now() || websiteProfileId(binding.owner, binding.ownerSubjectHash, binding.site, binding.target) !== binding.profileId || !await this.tickets.ownsProfileLease(binding.profileId, binding.profileLeaseOwner)) throw new CloudBrowserError('owner_forbidden', 'The sign-in binding is unavailable.');
    if (policy.target) await this.assertPublic(policy.target);
    const session = await this.store.loadSession(binding.sessionId);
    if (!session || session.owner !== binding.owner || session.ownerSubjectHash !== binding.ownerSubjectHash || session.profileId !== binding.profileId || !sameHosts(session.allowedHosts, policy.allowedHosts) || session.mode === 'public_web' || session.expiresAt <= this.now() || session.effectUnknown || !session.sensitiveOutputSuppressed || session.providerBrowserId !== 'aws.browser.v1') throw new CloudBrowserError('owner_forbidden', 'The sign-in session is unavailable.');
    return session;
  }
}

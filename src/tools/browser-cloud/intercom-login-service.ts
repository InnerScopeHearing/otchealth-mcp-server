import { createHash, randomBytes } from 'node:crypto';
import { CloudBrowserError, type CloudBrowserStore, type CloudBrowserSession } from './contract.js';
import { CloudBrowserService } from './service.js';
import { IntercomProfileProvider } from './intercom-profile-provider.js';
import { IntercomLoginTicketStore } from './intercom-login-store.js';
import { currentAuthConnectionId, currentAuthKind, currentAuthSubject, currentCallerHash } from '../../server/request-context.js';
import { AgentCoreCloudBrowserTransport } from './agentcore-transport.js';

/** New grants use a stable per-authorization ID; legacy tokens stay isolated by their
 * validated bearer hash until their next refresh upgrades the claim. Client ID alone
 * must never bind a persistent human browser profile. */
export function currentIntercomPrincipalKey(): string | undefined {
  if (currentAuthKind() !== 'oauth' || !currentAuthSubject()) return undefined;
  const connection = currentAuthConnectionId();
  if (connection) return `connection:${connection}`;
  const hash = currentCallerHash();
  return /^[a-f0-9]{64}$/i.test(hash) ? `legacy-token:${hash.toLowerCase()}` : undefined;
}
export function intercomPrincipalHash(subject: string | undefined): string {
  if (!subject || subject.length > 4096) throw new CloudBrowserError('oauth_subject_required', 'Use the authenticated COO connection.');
  return createHash('sha256').update(`coo\0${subject}`).digest('hex');
}
export function intercomProfileId(hash: string, workspace: string, host = 'app.intercom.com'): string {
  if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-zA-Z0-9]{3,32}$/.test(workspace) || !new Set(['app.intercom.com','app.eu.intercom.com','app.au.intercom.com']).has(host)) throw new CloudBrowserError('invalid_workspace', 'Use the company workspace ID from its dashboard address.');
  return `coo-intercom-${createHash('sha256').update(`${hash}\0${host}\0${workspace}`).digest('hex').slice(0,32)}`;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenValid = (value: string) => /^[a-zA-Z0-9_-]{43}$/.test(value);

/** Company login occurs inside an isolated provider session. No password passes through MCP. */
export class IntercomLoginService {
  constructor(private readonly store: CloudBrowserStore, private readonly browser: CloudBrowserService,
    private readonly transport: AgentCoreCloudBrowserTransport, private readonly provider: IntercomProfileProvider,
    private readonly tickets: IntercomLoginTicketStore, private readonly now: () => number = Date.now) {}

  async start(subject: string | undefined, workspace: string, host = 'app.intercom.com'): Promise<{ login_url: string; profile_id: string; session_id: string; expires_at: number; status: 'human_login_required' }> {
    const hash = intercomPrincipalHash(subject);
    const profileId = intercomProfileId(hash, workspace, host);
    let profile = await this.store.loadProfile(profileId);
    if (profile && (profile.owner !== 'coo' || profile.ownerSubjectHash !== hash)) throw new CloudBrowserError('owner_forbidden', 'Profile is unavailable to this connection.');
    if (profile && !profile.providerProfileId) throw new CloudBrowserError('profile_preparation_unknown', 'The prior profile preparation needs operator reconciliation.');
    if (!profile) {
      profile = { profileId, owner: 'coo', ownerSubjectHash: hash, allowedHosts: [host,'login.intercom.com'], persistent: true, maxSessionSeconds: 3600 };
      // Atomic create-only intent elects exactly one writer across gateway replicas.
      // A pending intent is never automatically retried after an ambiguous provider effect.
      if (!this.store.createProfileIntent || !await this.store.createProfileIntent(profile)) throw new CloudBrowserError('profile_preparation_unknown', 'Profile preparation is already pending.');
      const name = `cooIntercomAuth_${profileId.slice(-24)}`;
      const created = await this.provider.createProfile({ name, clientToken: digest(profileId), ownerSubjectHash: hash });
      if (!created.providerProfileId.startsWith(`${name}-`)) throw new CloudBrowserError('profile_create_invalid', 'The provider profile identity did not match its owned name.');
      profile = { ...profile, providerProfileId: created.providerProfileId };
      await this.browser.saveProfile('coo', profile, hash);
    }
    const started = await this.browser.start('coo', profileId, 3600, undefined, hash);
    try {
      await this.browser.beginSensitiveOutputSuppression('coo', started.sessionId, hash);
      const session = await this.ownedSession(started.sessionId, hash);
      await this.transport.prepareIntercomLogin(session, workspace, host);
      await this.transferControl(session, 'DISABLED');
      await this.store.saveSession(session);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = this.now() + 10 * 60_000;
      await this.tickets.create({ tokenHash: digest(token), ownerSubjectHash: hash, profileId, sessionId: started.sessionId, expectedWorkspaceId: workspace, expectedWorkspaceHost: host, expiresAt });
      return { login_url: `https://mcp.otchealth.app/browser/login#token=${token}`, profile_id: profileId, session_id: started.sessionId, expires_at: expiresAt, status: 'human_login_required' };
    } catch (error) { await this.browser.stop('coo', started.sessionId, hash).catch(() => undefined); throw error; }
  }

  async exchange(token: string): Promise<{ signed_url: string; expires_at: number; workspace_id: string; status: 'login_required' }> {
    if (!tokenValid(token)) throw new CloudBrowserError('login_expired', 'This login link is invalid or expired.');
    const binding = await this.tickets.exchange(digest(token));
    if (!binding) throw new CloudBrowserError('login_expired', 'This login link is invalid, consumed or expired.');
    const session = await this.ownedSession(binding.sessionId, binding.ownerSubjectHash);
    if (session.profileId !== binding.profileId || !session.sensitiveOutputSuppressed) throw new CloudBrowserError('login_invalid', 'The login session is unavailable.');
    await this.transferControl(session, 'DISABLED');
    const signed = await this.provider.generateLiveViewUrl({ browserIdentifier: session.providerBrowserId!, sessionId: session.providerSessionId, expiresIn: 300 });
    return { signed_url: signed.url, expires_at: this.now() + 300_000, workspace_id: binding.expectedWorkspaceId, status: 'login_required' };
  }

  async complete(token: string): Promise<{ status: 'saved'; workspace_id: string; verification: 'owner_confirmation_and_exact_settings_url' }> {
    if (!tokenValid(token)) throw new CloudBrowserError('login_expired', 'The login session is invalid.');
    const key = digest(token);
    const ticket = await this.tickets.load(key);
    if (!ticket || ticket.phase !== 'EXCHANGED' || !await this.tickets.finish(key)) throw new CloudBrowserError('login_expired', 'The login session is expired or already completed.');
    try {
      const session = await this.ownedSession(ticket.sessionId, ticket.ownerSubjectHash);
      if (session.profileId !== ticket.profileId || !session.sensitiveOutputSuppressed) throw new CloudBrowserError('login_invalid', 'The login session is unavailable.');
      await this.transferControl(session, 'ENABLED');
      // The explicit human Done action confirms the account; the server independently checks
      // the exact requested company workspace/settings URL and excludes sign-in/password pages.
      await this.transport.verifyIntercomLogin(session, ticket.expectedWorkspaceId, ticket.expectedWorkspaceHost);
      await this.browser.savePersistentProfile('coo', ticket.sessionId, ticket.ownerSubjectHash);
      // Retain suppression until confirmed stop; an ambiguous stop must not expose human input.
      await this.browser.stop('coo', ticket.sessionId, ticket.ownerSubjectHash);
      if (!await this.tickets.complete(key, 'SAVED')) throw new CloudBrowserError('login_save_unknown', 'The saved sign-in receipt could not be confirmed.');
      return { status: 'saved', workspace_id: ticket.expectedWorkspaceId, verification: 'owner_confirmation_and_exact_settings_url' };
    } catch (error) {
      await this.tickets.complete(key, 'FAILED').catch(() => undefined);
      await this.browser.stop('coo', ticket.sessionId, ticket.ownerSubjectHash).catch(() => undefined);
      throw error;
    }
  }

  private async transferControl(session: CloudBrowserSession, streamStatus: 'DISABLED' | 'ENABLED'): Promise<void> {
    if (!session.sensitiveOutputSuppressed || !session.providerBrowserId || !session.providerSessionId) throw new CloudBrowserError('login_invalid', 'The login session is unavailable.');
    const receipt = await this.provider.setAutomationStreamStatus({ browserIdentifier: session.providerBrowserId, sessionId: session.providerSessionId, streamStatus });
    if (receipt.browserIdentifier !== session.providerBrowserId || receipt.sessionId !== session.providerSessionId || receipt.streamStatus !== streamStatus) throw new CloudBrowserError('login_control_not_confirmed', 'The browser control transfer could not be confirmed.');
    if (streamStatus === 'ENABLED' && receipt.automationEndpoint && receipt.automationEndpoint !== session.automationEndpoint) {
      session.automationEndpoint = receipt.automationEndpoint;
      await this.store.saveSession(session);
    }
  }

  private async ownedSession(id: string, hash: string): Promise<CloudBrowserSession> {
    const session = await this.store.loadSession(id);
    if (!session || session.owner !== 'coo' || session.ownerSubjectHash !== hash || session.expiresAt <= this.now() || session.effectUnknown) throw new CloudBrowserError('owner_forbidden', 'Login session is unavailable.');
    return session;
  }
}

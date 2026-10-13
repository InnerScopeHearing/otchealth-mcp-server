import { randomUUID } from "node:crypto";
import { validateCloudBrowserAction } from "./actions.js";
import { CLOUD_BROWSER_DAILY_SESSION_LIMIT, CLOUD_BROWSER_MAX_ACTIONS, CLOUD_BROWSER_MAX_ACTION_SECONDS, CLOUD_BROWSER_MAX_SESSION_SECONDS, CLOUD_BROWSER_LEGACY_MAX_SESSION_SECONDS, type BrowserCaptureMetadata, type CloudBrowserAction, type CloudBrowserObservation, type CloudBrowserProfile, type CloudBrowserSession, type CloudBrowserStore, type CloudBrowserTransport, CloudBrowserError } from "./contract.js";
import { assertTrustedPublicWebProfile, type TrustedPublicWebPolicy } from './public-web-policy.js';

function validHost(host: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(host);
}

/**
 * These are the ordinary company Chat lanes that may receive an isolated public
 * trial profile. The protected personal-legal lane is deliberately absent.
 */
export const CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS = ["cto", "cfo", "clo", "coo", "cro", "developer", "wefunder-campaign-director"] as const;

export type CloudBrowserPublicTrialOwner = (typeof CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS)[number];

export function publicTrialProfileId(owner: CloudBrowserPublicTrialOwner): string {
  return `${owner}-public-trial`;
}

function isPublicTrialOwner(owner: string): owner is CloudBrowserPublicTrialOwner {
  return (CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS as readonly string[]).includes(owner);
}

function assertProfile(profile: CloudBrowserProfile, publicWebPolicy?: TrustedPublicWebPolicy): void {
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/i.test(profile.profileId) || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(profile.owner)) throw new CloudBrowserError("invalid_profile", "Profile identity is invalid.");
  if (profile.mode === "public_web") {
    assertTrustedPublicWebProfile(profile, publicWebPolicy);
    if (!profile.customBrowserIdentifier || !/^[A-Za-z0-9._-]{1,128}$/.test(profile.customBrowserIdentifier) || !Number.isSafeInteger(profile.actionBudget) || profile.actionBudget! < 1 || !Number.isSafeInteger(profile.maxSessionSeconds) || profile.maxSessionSeconds! < 1 || profile.maxSessionSeconds! > CLOUD_BROWSER_MAX_SESSION_SECONDS || !Number.isSafeInteger(profile.maxActionSeconds) || profile.maxActionSeconds! < 1) throw new CloudBrowserError("invalid_profile", "Public browser profile budgets are invalid.");
    return;
  }
  if (profile.allowedHosts.length === 0 || profile.allowedHosts.length > 24 || profile.allowedHosts.some((host) => !validHost(host))) throw new CloudBrowserError("invalid_profile", "Profile hosts are invalid.");
}
function publicWebUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function assertAction(action: CloudBrowserAction, hosts: readonly string[], mode?: CloudBrowserProfile["mode"]): void {
  validateCloudBrowserAction(action);
  if (action.type === "navigate" || action.type === "tab_create") {
    let url: URL;
    try {
      url = new URL(action.url);
    } catch {
      throw new CloudBrowserError("invalid_action", "Navigation URL is invalid.");
    }
    if (mode === "public_web" ? !publicWebUrl(action.url) : url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname.toLowerCase())) throw new CloudBrowserError("host_forbidden", "Navigation URL is not allowed for this profile.");
    return;
  }
  // Non-navigation operations share the same strict typed validation as the gateway.
}

function assertObservationHost(observation: CloudBrowserObservation | null, hosts: readonly string[], mode?: CloudBrowserProfile["mode"]): void {
  if (!observation?.url) throw new CloudBrowserError("provider_observation_invalid", "Browser provider did not return a current page URL.");
  let url: URL;
  try {
    url = new URL(observation.url);
  } catch {
    throw new CloudBrowserError("redirect_outside_allowlist", "Browser navigation ended outside the enrolled host policy.");
  }
  if (mode === "public_web" ? !publicWebUrl(observation.url) : url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname.toLowerCase())) throw new CloudBrowserError("redirect_outside_allowlist", "Browser navigation ended outside the enrolled host policy.");
}

/** Durable session orchestration. Caller binding is checked before every store or provider action. */
export class CloudBrowserService {
  constructor(
    private readonly store: CloudBrowserStore,
    private readonly transport: CloudBrowserTransport,
    private readonly now: () => number = Date.now,
    private readonly publicWebPolicy?: TrustedPublicWebPolicy,
  ) {}

  async saveProfile(caller: string, profile: CloudBrowserProfile): Promise<void> {
    if (profile.mode === "public_web") throw new CloudBrowserError("profile_provisioning_forbidden", "Public-web profiles are enrolled only by trusted server provisioning.");
    assertProfile(profile);
    if (caller !== profile.owner) throw new CloudBrowserError("owner_forbidden", "A profile can only be saved by its owner.");
    await this.store.saveProfile({
      ...profile,
      allowedHosts: [...new Set(profile.allowedHosts.map((host) => host.toLowerCase()))],
    });
  }

  async loadProfile(caller: string, profileId: string): Promise<CloudBrowserProfile> {
    const profile = await this.store.loadProfile(profileId);
    if (!profile || profile.owner !== caller) throw new CloudBrowserError("owner_forbidden", "Profile is unavailable to this caller.");
    return profile;
  }

  /**
   * Returns the one deterministic profile name a Chat lane may use. This avoids
   * profile-ID guessing while never enumerating another lane's profiles.
   */
  async publicTrialProfile(caller: string): Promise<Pick<CloudBrowserProfile, "profileId" | "allowedHosts" | "persistent">> {
    if (!isPublicTrialOwner(caller)) throw new CloudBrowserError("profile_not_enrolled", "This caller has no cloud-browser public profile.");
    const publicWebProfile = await this.enrolledPublicWebProfile(caller);
    if (publicWebProfile) {
      // Keep the existing discovery response contract for cached clients. The
      // public-web boundary is represented by an empty host list; callers do
      // not get a new tool or a way to enroll/convert profiles.
      return { profileId: publicWebProfile.profileId, allowedHosts: [], persistent: false };
    }
    const profile = await this.loadProfile(caller, publicTrialProfileId(caller));
    if (profile.mode === "public_web") throw new CloudBrowserError("profile_not_enrolled", "This caller has no legacy enrolled-host profile.");
    return { profileId: profile.profileId, allowedHosts: profile.allowedHosts, persistent: profile.persistent };
  }

  async publicWebProfile(caller: string): Promise<Pick<CloudBrowserProfile, "profileId" | "allowedHosts" | "persistent" | "mode" | "actionBudget" | "maxSessionSeconds" | "maxActionSeconds">> {
    if (!isPublicTrialOwner(caller)) throw new CloudBrowserError("profile_not_enrolled", "This caller has no cloud-browser public profile.");
    const profile = await this.enrolledPublicWebProfile(caller);
    if (!profile) throw new CloudBrowserError("profile_not_enrolled", "This caller has no verified public-web profile.");
    return {
      profileId: profile.profileId,
      allowedHosts: [],
      persistent: profile.persistent,
      mode: profile.mode,
      actionBudget: profile.actionBudget,
      maxSessionSeconds: profile.maxSessionSeconds,
      maxActionSeconds: profile.maxActionSeconds,
    };
  }

  /**
   * CTO provisions a public, non-persistent profile for one ordinary Chat lane.
   * The target owner is fixed from the allowlist and can never be the protected
   * personal-legal lane. Existing profiles retain their original owner because
   * the store's conditional write rejects ownership changes.
   */
  async provisionPublicTrialProfile(caller: string, owner: string, allowedHosts: readonly string[]): Promise<Pick<CloudBrowserProfile, "profileId" | "owner" | "allowedHosts" | "persistent">> {
    if (caller !== "cto") throw new CloudBrowserError("provisioner_forbidden", "Only the CTO lane may provision a public trial profile.");
    if (!isPublicTrialOwner(owner)) throw new CloudBrowserError("profile_owner_not_allowed", "The requested profile owner is not eligible for a public trial profile.");
    const profile: CloudBrowserProfile = {
      profileId: publicTrialProfileId(owner),
      owner,
      allowedHosts,
      persistent: false,
    };
    assertProfile(profile);
    await this.store.saveProfile({
      ...profile,
      allowedHosts: [...new Set(profile.allowedHosts.map((host) => host.toLowerCase()))],
    });
    return {
      profileId: profile.profileId,
      owner: profile.owner,
      allowedHosts: profile.allowedHosts.map((host) => host.toLowerCase()),
      persistent: false,
    };
  }

  async start(caller: string, profileId: string, maxSeconds: number, actionBudget?: number): Promise<{ sessionId: string; expiresAt: number }> {
    let resolvedProfileId = profileId;
    const publicWebProfileId = `${caller}-public-web`;
    if (isPublicTrialOwner(caller) && profileId === publicTrialProfileId(caller)) {
      const publicWebProfile = await this.enrolledPublicWebProfile(caller);
      if (publicWebProfile) resolvedProfileId = publicWebProfile.profileId;
    }
    const profile = await this.loadProfile(caller, resolvedProfileId);
    // A public-web profile ID is never allowed to fall through to an
    // enrolled-host profile if its server enrollment changes or is malformed.
    if (resolvedProfileId === publicWebProfileId && profile.mode !== "public_web") {
      throw new CloudBrowserError("invalid_profile", "The server-enrolled public-web profile is invalid.");
    }
    if (profile.mode === "public_web") assertProfile(profile, this.publicWebPolicy);
    const maxDuration = profile.mode === "public_web" ? profile.maxSessionSeconds! : CLOUD_BROWSER_LEGACY_MAX_SESSION_SECONDS;
    if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > maxDuration) throw new CloudBrowserError("invalid_duration", "Session duration exceeds the configured profile bound.");
    const selectedActionBudget = profile.mode === 'public_web' ? (actionBudget ?? profile.actionBudget) : CLOUD_BROWSER_MAX_ACTIONS;
    if (profile.mode === "public_web" && (!Number.isSafeInteger(selectedActionBudget) || selectedActionBudget! < 1 || selectedActionBudget! > profile.actionBudget!)) throw new CloudBrowserError("invalid_action_budget", "Public session action budget must be within the server configured mission budget.");
    const lockOwner = `${caller}:${randomUUID()}`;
    if (!(await this.store.acquireProfileLock(resolvedProfileId, lockOwner, this.now() + 30_000))) throw new CloudBrowserError("profile_busy", "Another browser session operation is in progress for this profile.");
    if (profile.mode !== "public_web" && !(await this.store.reserveDailySession(caller, new Date(this.now()).toISOString().slice(0, 10), CLOUD_BROWSER_DAILY_SESSION_LIMIT))) {
      await this.store.releaseProfileLock(resolvedProfileId, lockOwner);
      throw new CloudBrowserError("daily_session_limit", "The daily cloud-browser session limit has been reached.");
    }
    let remote: Pick<CloudBrowserSession, "providerSessionId" | "automationEndpoint" | "providerBrowserId">;
    try {
      remote = await this.transport.start({
        owner: caller,
        profile,
        maxSeconds,
      });
    } finally {
      await this.store.releaseProfileLock(resolvedProfileId, lockOwner);
    }
    const session: CloudBrowserSession = {
      sessionId: randomUUID(),
      owner: caller,
      profileId: profile.profileId,
      allowedHosts: profile.allowedHosts,
      mode: profile.mode ?? "enrolled_hosts",
      actionBudget: selectedActionBudget,
      expiresAt: this.now() + maxSeconds * 1_000,
      actionsUsed: 0,
      ...remote,
    };
    try {
      await this.store.saveSession(session);
    } catch (error) {
      await this.transport.stop(session).catch(() => undefined);
      throw error;
    }
    return { sessionId: session.sessionId, expiresAt: session.expiresAt };
  }

  async execute(caller: string, sessionId: string, action: CloudBrowserAction, timeoutSeconds: number): Promise<CloudBrowserObservation | import("./page-controls.js").BrowserPageReceipt | BrowserCaptureMetadata | null> {
    const session = await this.sessionFor(caller, sessionId);
    const profile = await this.loadProfile(caller, session.profileId);
    if ((profile.mode ?? "enrolled_hosts") !== (session.mode ?? "enrolled_hosts")) throw new CloudBrowserError("invalid_profile", "Browser session mode no longer matches its owner profile.");
    if (profile.mode === "public_web") assertProfile(profile, this.publicWebPolicy);
    const maxActionSeconds = session.mode === "public_web" ? profile.maxActionSeconds! : CLOUD_BROWSER_MAX_ACTION_SECONDS;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > maxActionSeconds) throw new CloudBrowserError("invalid_duration", "Action duration exceeds the configured profile bound.");
    if (session.actionsUsed >= (session.actionBudget ?? CLOUD_BROWSER_MAX_ACTIONS)) throw new CloudBrowserError("action_limit", "Session action budget reached.");
    assertAction(action, session.allowedHosts, session.mode);
    const lockOwner = `${caller}:${randomUUID()}`;
    if (!(await this.store.acquireSessionLock(sessionId, lockOwner, this.now() + (timeoutSeconds + 5) * 1_000))) throw new CloudBrowserError("session_busy", "Another bounded browser action is in progress for this session.");
    try {
      const current = await this.sessionFor(caller, sessionId);
      if (current.effectUnknown) throw new CloudBrowserError("effect_unknown", "A previous browser tab operation has an unknown result; reconcile the session before continuing.");
      if (action.type === 'capture' && (profile.persistent || Boolean(profile.providerProfileId) || current.sensitiveOutputSuppressed)) {
        throw new CloudBrowserError('sensitive_output_denied', 'Browser capture is unavailable for persistent or output-suppressed sessions.');
      }
      if (current.actionsUsed >= (current.actionBudget ?? CLOUD_BROWSER_MAX_ACTIONS)) throw new CloudBrowserError("action_limit", "Session action budget reached.");
      const deadline = this.now() + Math.min(timeoutSeconds, Math.max(1, Math.ceil((current.expiresAt - this.now()) / 1_000))) * 1_000;
      const remainingSeconds = (): number => Math.max(0, Math.ceil((deadline - this.now()) / 1_000));
      const checkCurrentPage = async (): Promise<CloudBrowserObservation> => {
        const remaining = remainingSeconds();
        if (remaining <= 0) throw new CloudBrowserError("provider_timeout", "Browser action exceeded its bounded deadline.");
        const value = await this.transport.execute(current, { type: "snapshot" }, remaining);
        const page = value && typeof value === "object" && "observation" in value ? value.observation : value;
        if (!page) throw new CloudBrowserError("provider_observation_invalid", "Browser provider did not return an observation.");
        assertObservationHost(page, current.allowedHosts, current.mode);
        return page as CloudBrowserObservation;
      };
      const mayRunWithoutSelection = (action.type === "tab_create" || action.type === "tab_select") && current.selectedTargetId === null;
      if (action.type !== "navigate" && !mayRunWithoutSelection) await checkCurrentPage();
      const effectIntent = action.type === "tab_create" || action.type === "tab_close";
      const captureIntent = action.type === 'capture';
      if (effectIntent) {
        current.effectUnknown = true;
        current.actionsUsed += 1;
        await this.store.saveSessionUnderLock(current, lockOwner);
      } else if (captureIntent) {
        // Captures are read-only, but consume budget before contacting the provider.
        current.actionsUsed += 1;
        await this.store.saveSessionUnderLock(current, lockOwner);
      }
      let result:
        | CloudBrowserObservation
        | null
        | {
            observation: CloudBrowserObservation | null;
            pageReceipt?: import("./page-controls.js").BrowserPageReceipt;
            capture?: import('./captures.js').BrowserCapturedArtifact;
          };
      try {
        if (action.type !== "wait_for") result = await this.transport.execute(current, action, remainingSeconds());
        else {
          for (;;) {
            if (remainingSeconds() <= 0) throw new CloudBrowserError("provider_timeout", "Browser wait action exceeded its bounded deadline.");
            try {
              result = await this.transport.execute(current, action, remainingSeconds());
              break;
            } catch (error) {
              if (!(error instanceof CloudBrowserError) || error.code !== "selector_not_found") throw error;
              await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, deadline - this.now()))));
            }
          }
        }
      } catch (error) {
        if (effectIntent && current.effectUnknown === false) await this.store.saveSessionUnderLock(current, lockOwner);
        else if (!effectIntent && current.effectUnknown) {
          current.actionsUsed += 1;
          await this.store.saveSessionUnderLock(current, lockOwner);
        }
        throw error;
      }
      const execution = result && typeof result === "object" && "observation" in result ? result : { observation: result };
      const observation = execution.observation;
      let captureMetadata: BrowserCaptureMetadata | undefined;
      let currentPage: CloudBrowserObservation | null = action.type === "snapshot" ? observation : null;
      try {
        if (!(action.type === "tab_close" && execution.pageReceipt?.selectedTargetId === null)) currentPage = action.type === "snapshot" ? observation : await checkCurrentPage();
      } catch (error) {
        if (action.type === "tab_create" || action.type === "tab_close") {
          current.effectUnknown = true;
          if (!effectIntent) current.actionsUsed += 1;
          await this.store.saveSessionUnderLock(current, lockOwner);
        }
        throw error;
      }
      if (currentPage) assertObservationHost(currentPage, current.allowedHosts, current.mode);
      if (action.type === 'capture') {
        if (!execution.capture) throw new CloudBrowserError('capture_failed', 'The browser capture could not be completed.');
        try { captureMetadata = await this.store.createCapture(caller, sessionId, execution.capture, this.now()); }
        catch { throw new CloudBrowserError('capture_storage_failed', 'The browser capture could not be stored safely.'); }
      }
      if (effectIntent) current.effectUnknown = false;
      await this.store.saveSessionUnderLock(
        {
          ...current,
          ownedTargetIds: current.ownedTargetIds,
          selectedTargetId: current.selectedTargetId,
          actionsUsed: current.actionsUsed + (effectIntent || captureIntent ? 0 : 1),
        },
        lockOwner,
      );
      return captureMetadata ?? execution.pageReceipt ?? (action.type === "snapshot" ? currentPage : observation);
    } finally {
      await this.store.releaseSessionLock(sessionId, lockOwner);
    }
  }

  /** Returns only a bounded accessibility observation, never DOM, screenshot, cookies, or endpoint. */
  async snapshot(caller: string, sessionId: string): Promise<CloudBrowserObservation> {
    const result = await this.execute(caller, sessionId, { type: "snapshot" }, 10);
    if (!result || !("url" in result)) throw new CloudBrowserError("provider_observation_invalid", "Browser provider did not return an observation.");
    return result;
  }

  async stop(caller: string, sessionId: string): Promise<void> {
    const session = await this.sessionFor(caller, sessionId, true);
    const lockOwner = `${caller}:${randomUUID()}`;
    if (!(await this.store.acquireSessionLock(sessionId, lockOwner, this.now() + 25_000))) throw new CloudBrowserError("session_busy", "Another bounded browser action is in progress for this session.");
    try {
      await this.transport.stop(session);
      await this.store.deleteSession(sessionId);
    } finally {
      await this.store.releaseSessionLock(sessionId, lockOwner);
    }
  }

  async savePersistentProfile(caller: string, sessionId: string): Promise<void> {
    const session = await this.sessionFor(caller, sessionId);
    const profile = await this.loadProfile(caller, session.profileId);
    if (!profile.persistent || !profile.providerProfileId || !this.transport.saveProfile) throw new CloudBrowserError("profile_not_persistent", "This session has no provider-backed persistent profile.");
    const lockOwner = `${caller}:${randomUUID()}`;
    if (!(await this.store.acquireProfileLock(profile.profileId, lockOwner, this.now() + 30_000))) throw new CloudBrowserError("profile_busy", "Another browser session operation is in progress for this profile.");
    try {
      await this.transport.saveProfile(session, profile);
    } finally {
      await this.store.releaseProfileLock(profile.profileId, lockOwner);
    }
  }

  /** Trusted authentication-runtime hook. There is intentionally no MCP route for either transition. */
  async beginSensitiveOutputSuppression(caller: string, sessionId: string): Promise<void> {
    await this.updateSensitiveOutputSuppression(caller, sessionId, true);
  }

  async endSensitiveOutputSuppression(caller: string, sessionId: string): Promise<void> {
    await this.updateSensitiveOutputSuppression(caller, sessionId, false);
  }

  private async updateSensitiveOutputSuppression(caller: string, sessionId: string, suppressed: boolean): Promise<void> {
    await this.sessionFor(caller, sessionId);
    const lockOwner = `${caller}:${randomUUID()}`;
    if (!(await this.store.acquireSessionLock(sessionId, lockOwner, this.now() + 5_000))) throw new CloudBrowserError('session_busy', 'Another browser action is in progress for this session.');
    try {
      const current = await this.sessionFor(caller, sessionId);
      await this.store.saveSessionUnderLock({ ...current, sensitiveOutputSuppressed: suppressed }, lockOwner);
    } finally { await this.store.releaseSessionLock(sessionId, lockOwner); }
  }

  async getCapture(caller: string, captureId: string): Promise<{ metadata: BrowserCaptureMetadata; body: Uint8Array }> {
    const value = await this.store.loadCapture(caller, captureId);
    if (!value || value.metadata.owner !== caller) throw new CloudBrowserError('owner_forbidden', 'Capture is unavailable to this caller.');
    return value;
  }

  private async sessionFor(caller: string, sessionId: string, allowExpired = false): Promise<CloudBrowserSession> {
    const session = await this.store.loadSession(sessionId);
    if (!session || session.owner !== caller) throw new CloudBrowserError("owner_forbidden", "Session is unavailable to this caller.");
    if (!allowExpired && session.expiresAt <= this.now()) throw new CloudBrowserError("session_expired", "Session expired and must be stopped before a new session starts.");
    return session;
  }

  /**
   * Loads only the caller's deterministic root-enrolled public-web profile.
   * A missing record permits legacy fallback; a present but invalid/misowned
   * record fails closed so it cannot silently downgrade to host-only policy.
   */
  private async enrolledPublicWebProfile(caller: string): Promise<CloudBrowserProfile | null> {
    const profileId = `${caller}-public-web`;
    const profile = await this.store.loadProfile(profileId);
    if (!profile) return null;
    if (profile.owner !== caller) throw new CloudBrowserError("owner_forbidden", "Profile is unavailable to this caller.");
    if (profile.profileId !== profileId || profile.mode !== "public_web") throw new CloudBrowserError("invalid_profile", "The server-enrolled public-web profile is invalid.");
    assertProfile(profile, this.publicWebPolicy);
    return profile;
  }
}

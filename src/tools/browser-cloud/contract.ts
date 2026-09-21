/**
 * Cloud browser contract.  The persistence payload deliberately contains no cookie,
 * credential, endpoint, or browser-profile value.  The provider retains those values.
 */
export const CLOUD_BROWSER_MAX_SESSION_SECONDS = 180;
export const CLOUD_BROWSER_DAILY_SESSION_LIMIT = 10;
export const CLOUD_BROWSER_MAX_ACTIONS = 20;
export const CLOUD_BROWSER_MAX_ACTION_SECONDS = 20;

export type CloudBrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; selector: string }
  | { type: 'type'; selector: string; text: string }
  | { type: 'wait_for'; selector: string }
  | { type: 'snapshot' };

export interface CloudBrowserObservation {
  url: string | null;
  title: string | null;
  /** Bounded accessibility names. Page-visible data may still be sensitive. */
  visibleText: string;
}

export interface CloudBrowserProfile {
  profileId: string;
  /** AgentCore Browser Profile ID. It is an opaque resource ID, never profile contents. */
  providerProfileId?: string;
  owner: string;
  allowedHosts: readonly string[];
  persistent: boolean;
}

export interface CloudBrowserSession {
  sessionId: string;
  owner: string;
  profileId: string;
  allowedHosts: readonly string[];
  expiresAt: number;
  actionsUsed: number;
  /** Opaque provider identifier, never return this to MCP callers. */
  providerSessionId: string;
  /** Opaque provider endpoint, never return this to MCP callers. */
  automationEndpoint: string;
}

export interface CloudBrowserStore {
  loadProfile(profileId: string): Promise<CloudBrowserProfile | null>;
  saveProfile(profile: CloudBrowserProfile): Promise<void>;
  loadSession(sessionId: string): Promise<CloudBrowserSession | null>;
  saveSession(session: CloudBrowserSession): Promise<void>;
  saveSessionUnderLock(session: CloudBrowserSession, lockOwner: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  acquireSessionLock(sessionId: string, owner: string, until: number): Promise<boolean>;
  releaseSessionLock(sessionId: string, owner: string): Promise<void>;
  acquireProfileLock(profileId: string, owner: string, until: number): Promise<boolean>;
  releaseProfileLock(profileId: string, owner: string): Promise<void>;
  reserveDailySession(owner: string, day: string, limit: number): Promise<boolean>;
}

export interface CloudBrowserTransport {
  start(input: { owner: string; profile: CloudBrowserProfile; maxSeconds: number }): Promise<Pick<CloudBrowserSession, 'providerSessionId' | 'automationEndpoint'>>;
  execute(session: CloudBrowserSession, action: CloudBrowserAction, timeoutSeconds: number): Promise<CloudBrowserObservation | null>;
  stop(session: CloudBrowserSession): Promise<void>;
  /** Persist the active remote browser state (cookies/local storage) at the provider, never locally. */
  saveProfile?(session: CloudBrowserSession, profile: CloudBrowserProfile): Promise<void>;
}

export class CloudBrowserError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CloudBrowserError'; }
}

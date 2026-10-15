/**
 * Cloud browser contract.  The persistence payload deliberately contains no cookie,
 * credential, endpoint, or browser-profile value.  The provider retains those values.
 */
/** AgentCore StartBrowserSession documents a maximum TTL of 28,800 seconds. */
export const CLOUD_BROWSER_MAX_SESSION_SECONDS = 28_800;
export const CLOUD_BROWSER_LEGACY_MAX_SESSION_SECONDS = 180;
export const CLOUD_BROWSER_DAILY_SESSION_LIMIT = 10;
export const CLOUD_BROWSER_MAX_ACTIONS = 20;
export const CLOUD_BROWSER_MAX_ACTION_SECONDS = 20;
export const CLOUD_BROWSER_KEYS = ["Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "KeyA", "KeyC", "KeyV", "KeyP", "KeyS", "KeyF", "KeyZ", "F5"] as const;
export type BrowserCaptureRequest = import('./captures.js').BrowserCaptureRequest;

export type CloudBrowserAction =
  | import("./page-controls.js").BrowserPageAction
  | { type: "navigate"; url: string }
  | {
      type: "click";
      selector: string;
      button?: "left" | "right";
      clickCount?: 1 | 2;
    }
  | { type: "type"; selector: string; text: string }
  | { type: "wait_for"; selector: string }
  | { type: "snapshot" }
  | { type: "capture"; request: BrowserCaptureRequest }
  | { type: "upload"; selector: string; fileId: string }
  | {
      type: "press_key";
      key: (typeof CLOUD_BROWSER_KEYS)[number];
      modifiers?: number;
    }
  | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "mouse_move"; x: number; y: number }
  | {
      type: "drag";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      steps?: number;
    };

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
  /** Optional authenticated subject binding; stored as a one-way hash only. */
  ownerSubjectHash?: string;
  allowedHosts: readonly string[];
  persistent: boolean;
  /** Missing mode is the original exact-host policy for backwards compatibility. */
  mode?: "enrolled_hosts" | "public_web";
  /** Set only by trusted provisioning after isolated network policy is verified. */
  customBrowserIdentifier?: string;
  networkPolicyVersion?: string;
  /** Provider proxy configuration; secret references only, never secret values. */
  proxyConfiguration?: {
    proxies: Array<Record<string, unknown>>;
    bypass?: { domainPatterns: string[] };
  };
  /** Server-owned destination boundary configuration version/receipt reference. */
  privateHostPolicy?: string;
  /** Explicit per-mission action budget, set by the caller when starting a session. */
  actionBudget?: number;
  maxSessionSeconds?: number;
  maxActionSeconds?: number;
}

export interface CloudBrowserSession {
  sessionId: string;
  owner: string;
  /** Optional authenticated subject binding copied from the profile at session start. */
  ownerSubjectHash?: string;
  profileId: string;
  allowedHosts: readonly string[];
  expiresAt: number;
  actionsUsed: number;
  /** Opaque provider identifier, never return this to MCP callers. */
  providerSessionId: string;
  /** Browser resource used to create this session, needed for correct stop/save. */
  providerBrowserId?: string;
  mode?: "enrolled_hosts" | "public_web";
  actionBudget?: number;
  /** Opaque provider endpoint, never return this to MCP callers. */
  automationEndpoint: string;
  /** Optional additive page ownership state; absent in legacy records. */
  ownedTargetIds?: string[];
  selectedTargetId?: string | null;
  /** Blocks further effects after an acknowledgement loss until owner reconciliation. */
  effectUnknown?: boolean;
  /** Trusted auth runtime sets this fail-closed output suppression state; no caller tool can clear it. */
  sensitiveOutputSuppressed?: boolean;
  /** Trusted human-login runtime copies the exact profile lease owner; never accepted by caller tools. */
  loginLeaseOwner?: string;
  /** Persisted before provider stop so explicit retries reuse the same AWS idempotency key. */
  providerStopToken?: string;
  /** Acknowledged provider stop; retain this receipt until lease and SESSION cleanup finish. */
  providerStopped?: boolean;
}

export interface CloudBrowserExecutionResult {
  observation: CloudBrowserObservation | null;
  pageReceipt?: import("./page-controls.js").BrowserPageReceipt;
  capture?: import('./captures.js').BrowserCapturedArtifact;
  fileReceipt?: import('./provider-files.js').BrowserFileTransferReceipt;
}

export interface BrowserCaptureMetadata {
  id: string;
  owner: string;
  /** Optional authenticated subject binding copied from the session that created the capture. */
  ownerSubjectHash?: string;
  sessionId: string;
  contentType: 'image/png' | 'image/jpeg' | 'application/pdf';
  byteLength: number;
  sha256: string;
  createdAt: number;
  pageCount?: number;
}

export interface BrowserCaptureRecord extends BrowserCaptureMetadata {
  storageKey: string;
  storageVersion: string;
}

export interface CloudBrowserStore {
  /** Atomic create-only provider preparation intent; unsupported stores cannot provision. */
  createProfileIntent?(profile: CloudBrowserProfile): Promise<boolean>;
  /** Trusted human-login lease: ordinary starts/saves cannot reuse a profile until its login stops. */
  verifyLoginLease?(profileId: string, leaseOwner?: string): Promise<boolean>;
  /** Release only this confirmed-stopped, principal-bound session's exact trusted login lease. */
  releaseStoppedLoginLease?(session: CloudBrowserSession, lockOwner: string): Promise<void>;
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
  createCapture(owner: string, sessionId: string, artifact: import('./captures.js').BrowserCapturedArtifact, createdAt: number, ownerSubjectHash?: string): Promise<BrowserCaptureMetadata>;
  loadCapture(owner: string, captureId: string, principalHash?: string): Promise<{ metadata: BrowserCaptureMetadata; body: Uint8Array } | null>;
}

export interface CloudBrowserTransport {
  start(input: { owner: string; profile: CloudBrowserProfile; maxSeconds: number }): Promise<Pick<CloudBrowserSession, "providerSessionId" | "automationEndpoint" | "providerBrowserId">>;
  /** Trusted invocation binding is used only for uploads through legacy unbound session profiles. */
  execute(session: CloudBrowserSession, action: CloudBrowserAction, timeoutSeconds: number, uploadPrincipalHash?: string): Promise<CloudBrowserObservation | null | CloudBrowserExecutionResult>;
  stop(session: CloudBrowserSession): Promise<void>;
  /** Persist the active remote browser state (cookies/local storage) at the provider, never locally. */
  saveProfile?(session: CloudBrowserSession, profile: CloudBrowserProfile): Promise<void>;
}

export class CloudBrowserError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudBrowserError";
  }
}

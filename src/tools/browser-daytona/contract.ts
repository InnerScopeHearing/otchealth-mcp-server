import type { CloudBrowserAction } from '../browser-cloud/contract.js';

/** Server-enrolled identity. No caller-supplied sandbox, credential or preview token. */
export interface DaytonaBinding {
  provider: 'daytona';
  owner: string;
  ownerSubjectHash: string;
  sandboxId: string;
  profileKey: string;
  /** Explicit immutable server-admin membership; never caller/MCP input.
   * profileKey remains the virtual owner/principal identity in auth and storage.
   */
  sharedProfileKey?: 'company-browser';
  profilePath: string;
  readinessReceiptSha256: string;
}

/** Physical runtime identity only; callers must first validate the enrollment. */
export function daytonaPhysicalProfileKey(binding: DaytonaBinding): string {
  return binding.sharedProfileKey ?? binding.profileKey;
}

export interface DaytonaMission {
  provider: 'daytona';
  sessionId: string;
  owner: string;
  ownerSubjectHash: string;
  profileKey: string;
  sandboxId: string;
  expiresAt: number;
  actionsUsed: number;
  actionBudget: number;
  effectUnknown: boolean;
  phase: 'OPENING' | 'ACTIVE' | 'RELEASING' | 'CLOSED';
  /** Server-persisted only after a fresh exact V2 multi-mission runtime proof. */
  runtimeProtocol?: 2;
  sensitiveOutputSuppressed?: boolean;
  /** Opaque server grant ID only; the provider retains encrypted token material. */
  viewerGrantHandle?: string;
  viewerExpiresAt?: number;
}

/** Ephemeral proof for one exact enrolled profile, never a global readiness flag. */
export interface DaytonaRuntimeReadiness {
  ready: true;
  profileKey: string;
  profilePath: string;
  checkpointReady: boolean;
  browserPid?: number;
  supervisorPid?: number;
  runtimeProtocol?: 2;
  multiMissionReady?: boolean;
}

export interface DaytonaProvider {
  probe?(binding: DaytonaBinding): Promise<DaytonaRuntimeReadiness>;
  inspect(binding: DaytonaBinding): Promise<{ sandboxId: string; state: 'started' | 'stopped' | 'other'; public: boolean }>;
  openMission(binding: DaytonaBinding, logicalSessionId: string, options?: { runtimeProtocol?: 2 }): Promise<void>;
  execute(binding: DaytonaBinding, session: DaytonaMission, action: CloudBrowserAction, timeoutSeconds: number, principalHash: string): Promise<unknown>;
  /** Trusted current mission is required by concrete lifecycle providers across replicas. */
  checkpoint(binding: DaytonaBinding, session?: DaytonaMission): Promise<void>;
  /** Detach this logical mission only. Never stop/delete the retained desktop. */
  releaseMission(binding: DaytonaBinding, session: DaytonaMission): Promise<void>;
  /** Global human handoff fence, with the exact V2 initiating mission retained. */
  pauseAutomation?(binding: DaytonaBinding, session: DaytonaMission): Promise<{ paused: true }>;
  resumeAutomation?(binding: DaytonaBinding, session: DaytonaMission): Promise<{ resumed: true }>;
  viewerGrant(binding: DaytonaBinding, expiresSeconds: number): Promise<{ url: string; expiresAt: number; grantHandle: string }>;
  /** Read exactly the existing encrypted grant; never mint or extend it. */
  readViewerGrant(binding: DaytonaBinding, grantHandle: string): Promise<{ url: string; expiresAt: number; grantHandle: string }>;
  /** Provider's private encrypted TTL grant namespace retains the secret token. */
  revokeViewerGrant(binding: DaytonaBinding, grantHandle: string): Promise<{ human_input_revoked: true }>;
}

export interface DaytonaBrowserStore {
  loadBinding(profileKey: string): Promise<DaytonaBinding | null>;
  /** Trusted enrollment only; immutable create-only readiness record. */
  createBinding(binding: DaytonaBinding): Promise<boolean>;
  loadSession(sessionId: string): Promise<DaytonaMission | null>;
  createSession(session: DaytonaMission): Promise<boolean>;
  saveSessionUnderLock(session: DaytonaMission, lockOwner: string): Promise<void>;
  acquireSessionLock(sessionId: string, lockOwner: string, until: number): Promise<boolean>;
  releaseSessionLock(sessionId: string, lockOwner: string): Promise<void>;
  acquireProfileLease(profileKey: string, leaseOwner: string, until: number): Promise<boolean>;
  ownsProfileLease(profileKey: string, leaseOwner: string): Promise<boolean>;
  releaseProfileLease(profileKey: string, leaseOwner: string): Promise<void>;
}

export class DaytonaBrowserError extends Error {
  constructor(readonly code: string, message = 'The owned Daytona browser operation could not be completed safely.') {
    super(message); this.name = 'DaytonaBrowserError';
  }
}

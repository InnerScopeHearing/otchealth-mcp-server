import { randomUUID } from 'node:crypto';

const CHALLENGE_TTL_MS = 5 * 60_000;
const CLAIM_TTL_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 2_000;

export interface BrowserCredentialBinding {
  bindingId: string;
  owner: string;
  origin: string;
  accountId: string;
  /** Opaque reference understood only by the trusted browser runtime. Never a secret value. */
  credentialReference: string;
  providerProfileId?: string;
  version: number;
  revoked: boolean;
}

export interface BrowserCredentialBindingStore {
  loadBinding(bindingId: string): Promise<BrowserCredentialBinding | null>;
}

export interface BrowserAuthChallenge {
  challengeId: string;
  owner: string;
  bindingId: string;
  bindingVersion: number;
  sessionId: string;
  origin: string;
  accountId: string;
  expiresAt: number;
  /** Opaque provider run handle; provider verification is always authoritative. */
  runHandle: string;
  completed: boolean;
}

export type BrowserAuthOperationState = 'in_progress' | 'challenge_required' | 'completed' | 'unknown';
export interface BrowserAuthOperation {
  key: string;
  owner: string;
  bindingId: string;
  bindingVersion: number;
  sessionId: string;
  state: BrowserAuthOperationState;
  challengeId?: string;
}

export interface BrowserAuthClaim {
  key: string;
  claimant: string;
  until: number;
  /** Monotonically increasing store supplied fencing token. */
  fence: number;
}

export interface BrowserChallengeStore {
  loadChallenge(challengeId: string): Promise<BrowserAuthChallenge | null>;
  saveChallenge(challenge: BrowserAuthChallenge): Promise<void>;
  /** Conditional owner/run-handle transition; false means already consumed or changed. */
  completeChallenge(challengeId: string, owner: string, runHandle: string): Promise<boolean>;
  loadOperation(key: string): Promise<BrowserAuthOperation | null>;
  /** Must be conditional on the same fencing token as the current claim. */
  saveOperation(operation: BrowserAuthOperation, claim: BrowserAuthClaim): Promise<void>;
  claim(key: string, claimant: string, until: number): Promise<BrowserAuthClaim | null>;
  release(claim: BrowserAuthClaim): Promise<void>;
}

export interface BrowserCredentialRuntime {
  verifyOwnedSession(owner: string, sessionId: string): Promise<boolean>;
  /**
   * Starts a session-bound, fail-closed output suppression lease. The lease must
   * never auto-expire or unmask output; only explicit endSensitiveMode may release it.
   */
  beginSensitiveMode(owner: string, sessionId: string): Promise<{ suppressed: boolean; leaseId: string }>;
  injectReference(input: {
    owner: string;
    sessionId: string;
    origin: string;
    credentialReference: string;
    providerProfileId?: string;
  }): Promise<{ authenticated: boolean; challengeRequired: boolean; runHandle?: string }>;
  verifyChallenge(challenge: BrowserAuthChallenge): Promise<boolean>;
  /** Must be idempotent and confirm all sensitive form state has been cleared. */
  sanitizeSensitiveState(leaseId: string): Promise<{ cleared: boolean }>;
  /** Releases the fail-closed suppression lease only after positive sanitation confirmation. */
  endSensitiveMode(leaseId: string): Promise<void>;
}

export type BrowserAuthResult = { status: 'authenticated' } | { status: 'challenge_required'; challengeId: string };

export class BrowserAuthBrokerError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BrowserAuthBrokerError'; }
}

function fail(code: string, message: string): never { throw new BrowserAuthBrokerError(code, message); }

function canonicalOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail('invalid_origin', 'The origin is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || parsed.port || parsed.origin !== value) {
    return fail('invalid_origin', 'The origin is invalid.');
  }
  return parsed.origin;
}

function safeRuntimeError(): BrowserAuthBrokerError {
  return new BrowserAuthBrokerError('runtime_unavailable', 'The browser authentication operation could not be confirmed. Reconcile the existing session before retrying.');
}

/**
 * Bridges an already-authorized credential reference into an already-owned browser
 * session. It does not retrieve, inspect, persist, or return credential contents.
 */
export class BrowserAuthBroker {
  constructor(private readonly ports: {
    bindings: BrowserCredentialBindingStore;
    runtime: BrowserCredentialRuntime;
    challenges: BrowserChallengeStore;
    now: () => number;
  }) {}

  private get now(): () => number { return this.ports.now; }

  async authenticate(owner: string, input: { sessionId: string; bindingId: string; origin: string; accountId: string }): Promise<BrowserAuthResult> {
    const origin = canonicalOrigin(input.origin);
    const binding = await this.loadAuthorizedBinding(owner, input.bindingId, origin, input.accountId);
    const key = `auth:${owner}:${binding.bindingId}:${binding.version}:${input.sessionId}`;
    const claim = await this.acquire(key);
    try {
      const existing = await this.ports.challenges.loadOperation(key);
      if (existing) {
        if (existing.state === 'challenge_required' && existing.challengeId) return { status: 'challenge_required', challengeId: existing.challengeId };
        fail(existing.state === 'unknown' || existing.state === 'in_progress' ? 'operation_reconciliation_required' : 'operation_already_completed', 'This authentication operation cannot be repeated.');
      }
      await this.ports.challenges.saveOperation({ key, owner, bindingId: binding.bindingId, bindingVersion: binding.version, sessionId: input.sessionId, state: 'in_progress' }, claim);
      if (!await this.ports.runtime.verifyOwnedSession(owner, input.sessionId)) fail('session_unavailable', 'The browser session is unavailable to this owner.');
      const leaseId = await this.beginSuppressed(owner, input.sessionId);
      let result: { authenticated: boolean; challengeRequired: boolean; runHandle?: string };
      try {
        result = await this.ports.runtime.injectReference({
          owner, sessionId: input.sessionId, origin, credentialReference: binding.credentialReference,
          ...(binding.providerProfileId ? { providerProfileId: binding.providerProfileId } : {}),
        });
      } catch {
        await this.ports.challenges.saveOperation({ key, owner, bindingId: binding.bindingId, bindingVersion: binding.version, sessionId: input.sessionId, state: 'unknown' }, claim).catch(() => undefined);
        throw safeRuntimeError();
      } finally { await this.finishSensitiveMode(leaseId); }
      if (result.challengeRequired) {
        if (!result.runHandle) {
          await this.ports.challenges.saveOperation({ key, owner, bindingId: binding.bindingId, bindingVersion: binding.version, sessionId: input.sessionId, state: 'unknown' }, claim);
          fail('operation_reconciliation_required', 'The provider challenge could not be safely resumed.');
        }
        const challengeId = randomUUID();
        await this.ports.challenges.saveChallenge({
          challengeId, owner, bindingId: binding.bindingId, bindingVersion: binding.version, sessionId: input.sessionId,
          origin, accountId: input.accountId, expiresAt: this.now() + CHALLENGE_TTL_MS, runHandle: result.runHandle, completed: false,
        });
        await this.ports.challenges.saveOperation({ key, owner, bindingId: binding.bindingId, bindingVersion: binding.version, sessionId: input.sessionId, state: 'challenge_required', challengeId }, claim);
        return { status: 'challenge_required', challengeId };
      }
      if (!result.authenticated) {
        await this.ports.challenges.saveOperation({ key, owner, bindingId: binding.bindingId, bindingVersion: binding.version, sessionId: input.sessionId, state: 'unknown' }, claim);
        fail('authentication_incomplete', 'The browser provider did not confirm authentication.');
      }
      await this.ports.challenges.saveOperation({ key, owner, bindingId: binding.bindingId, bindingVersion: binding.version, sessionId: input.sessionId, state: 'completed' }, claim);
      return { status: 'authenticated' };
    } catch (error) {
      if (error instanceof BrowserAuthBrokerError) throw error;
      throw safeRuntimeError();
    } finally { await this.releaseClaim(claim); }
  }

  async resume(owner: string, challengeId: string): Promise<BrowserAuthResult> {
    let challenge: BrowserAuthChallenge | null;
    try { challenge = await this.ports.challenges.loadChallenge(challengeId); } catch { throw safeRuntimeError(); }
    if (!challenge || challenge.owner !== owner || challenge.completed) fail('challenge_unavailable', 'The browser authentication challenge is unavailable.');
    if (!Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= this.now()) fail('challenge_expired', 'The browser authentication challenge has expired.');
    const binding = await this.loadAuthorizedBinding(owner, challenge.bindingId, challenge.origin, challenge.accountId);
    if (binding.version !== challenge.bindingVersion) fail('binding_changed', 'The authorized credential binding has changed.');
    const operationKey = `auth:${owner}:${binding.bindingId}:${binding.version}:${challenge.sessionId}`;
    const claim = await this.acquire(operationKey);
    try {
      const current = await this.ports.challenges.loadChallenge(challengeId);
      if (!current || current.owner !== owner || current.completed || current.runHandle !== challenge.runHandle || current.expiresAt <= this.now()) fail('challenge_unavailable', 'The browser authentication challenge is unavailable.');
      if (!await this.ports.runtime.verifyOwnedSession(owner, challenge.sessionId)) fail('session_unavailable', 'The browser session is unavailable to this owner.');
      const leaseId = await this.beginSuppressed(owner, challenge.sessionId);
      let complete: boolean;
      try { complete = await this.ports.runtime.verifyChallenge(current); }
      catch { throw safeRuntimeError(); }
      finally { await this.finishSensitiveMode(leaseId); }
      if (!complete) return { status: 'challenge_required', challengeId };
      if (!await this.ports.challenges.completeChallenge(challengeId, owner, current.runHandle)) fail('challenge_unavailable', 'The browser authentication challenge is unavailable.');
      const operation = await this.ports.challenges.loadOperation(operationKey);
      if (!operation || operation.state !== 'challenge_required' || operation.challengeId !== challengeId) fail('operation_reconciliation_required', 'The browser authentication result needs reconciliation.');
      await this.ports.challenges.saveOperation({ ...operation, state: 'completed' }, claim);
      return { status: 'authenticated' };
    } catch (error) {
      if (error instanceof BrowserAuthBrokerError) throw error;
      throw safeRuntimeError();
    } finally { await this.releaseClaim(claim); }
  }

  private async loadAuthorizedBinding(owner: string, bindingId: string, origin: string, accountId: string): Promise<BrowserCredentialBinding> {
    let binding: BrowserCredentialBinding | null;
    try { binding = await this.ports.bindings.loadBinding(bindingId); } catch { throw safeRuntimeError(); }
    if (!binding || binding.owner !== owner || binding.bindingId !== bindingId || binding.origin !== origin || binding.accountId !== accountId || binding.revoked || !Number.isSafeInteger(binding.version) || binding.version < 1 || !binding.credentialReference) {
      fail('binding_unavailable', 'The authorized credential binding is unavailable.');
    }
    return binding;
  }

  private async acquire(key: string): Promise<BrowserAuthClaim> {
    const claimant = randomUUID();
    const claim = await this.ports.challenges.claim(key, claimant, this.now() + CLAIM_TTL_MS);
    if (!claim || claim.key !== key || claim.claimant !== claimant || claim.until <= this.now() || !Number.isSafeInteger(claim.fence) || claim.fence < 1) fail('operation_busy', 'Another browser authentication operation is in progress.');
    return claim;
  }

  private async releaseClaim(claim: BrowserAuthClaim): Promise<void> {
    try { await this.ports.challenges.release(claim); } catch { /* Expiring lease is the bounded fallback. */ }
  }

  private async beginSuppressed(owner: string, sessionId: string): Promise<string> {
    let lease: { suppressed: boolean; leaseId: string };
    try { lease = await this.ports.runtime.beginSensitiveMode(owner, sessionId); }
    catch { throw safeRuntimeError(); }
    if (!lease.suppressed || !lease.leaseId) {
      if (lease.leaseId) await this.finishSensitiveMode(lease.leaseId);
      fail('sensitive_mode_unavailable', 'Sensitive browser output could not be suppressed.');
    }
    return lease.leaseId;
  }

  private async boundedCleanup<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup_timeout')), CLEANUP_TIMEOUT_MS); }),
      ]);
    } catch { throw safeRuntimeError(); }
    finally { if (timer) clearTimeout(timer); }
  }

  private async finishSensitiveMode(leaseId: string): Promise<void> {
    let sanitation: { cleared: boolean };
    try { sanitation = await this.boundedCleanup(() => this.ports.runtime.sanitizeSensitiveState(leaseId)); }
    catch { throw safeRuntimeError(); }
    if (!sanitation?.cleared) throw safeRuntimeError();
    try { await this.boundedCleanup(() => this.ports.runtime.endSensitiveMode(leaseId)); }
    catch { throw safeRuntimeError(); }
  }
}

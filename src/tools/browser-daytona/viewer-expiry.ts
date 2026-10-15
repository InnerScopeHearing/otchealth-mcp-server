import type { DaytonaBinding } from './contract.js';
import { assertDaytonaViewerGrantRecord, daytonaViewerGrantBindingHash, daytonaViewerPhysicalScopeHash, type DaytonaViewerGrantStore } from './viewer-grant-store.js';

export type DaytonaViewerExpiryResult = { status: 'idle' | 'active' | 'expired_revoked' | 'busy' }
  | { status: 'operator_attention'; reason: 'receipt_invalid' | 'effect_unknown' | 'operation_unconfirmed' };
export interface DaytonaViewerExpiryOptions {
  store: DaytonaViewerGrantStore;
  port: { revoke(binding: DaytonaBinding, handle: string, signal?: AbortSignal): Promise<{ human_input_revoked: true }> };
  /** Fixed trusted startup enrollment. Never a browser/tool-supplied target. */
  organizationId: string;
  sandboxId: string;
  deadlineMs?: number;
  freshnessMs?: number;
  now?: () => number;
}

/** Explicit server-only tick. Constructor NEVER starts timers or provider calls.
 * Boot must reconcile before enabling human flows, then schedule ~1s ticks and
 * gate issuance on ready(). A URL's expiry alone cannot disconnect old VNC WS.
 */
export class DaytonaViewerExpiryController {
  private readonly scopeHash: string;
  private readonly now: () => number;
  private readonly deadline: number;
  private readonly freshness: number;
  private inFlight = false;
  private checkedAt: number | undefined;
  private healthy = false;
  constructor(private readonly options: DaytonaViewerExpiryOptions) {
    this.scopeHash = daytonaViewerPhysicalScopeHash(options.organizationId, options.sandboxId);
    this.now = options.now ?? Date.now; this.deadline = options.deadlineMs ?? 20000; this.freshness = options.freshnessMs ?? 2500;
    if (!options.store || !options.port || typeof options.port.revoke !== 'function' || !Number.isSafeInteger(this.deadline) || this.deadline < 1 || this.deadline > 20000 || !Number.isSafeInteger(this.freshness) || this.freshness < 1 || this.freshness > 5000) throw new Error('invalid_daytona_viewer_expiry_configuration');
  }
  ready(): boolean {
    const age = this.checkedAt === undefined ? -1 : this.now() - this.checkedAt;
    return this.healthy && age >= 0 && age <= this.freshness;
  }
  async tick(): Promise<DaytonaViewerExpiryResult> {
    if (this.inFlight) return { status: 'busy' };
    this.inFlight = true; const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => abort.signal.throwIfAborted();
    const operation = async (): Promise<DaytonaViewerExpiryResult> => {
      const handle = await this.options.store.readPhysicalScope(this.scopeHash, abort.signal); check();
      if (handle === null) return { status: 'idle' };
      const receipt = await this.options.store.load(handle, abort.signal); check();
      try {
        assertDaytonaViewerGrantRecord(receipt);
        if (receipt.grantHandle !== handle || receipt.organizationId !== this.options.organizationId || receipt.binding.sandboxId !== this.options.sandboxId || receipt.scopeHash !== this.scopeHash || receipt.bindingHash !== daytonaViewerGrantBindingHash(this.options.organizationId, receipt.binding)) return { status: 'operator_attention', reason: 'receipt_invalid' };
      } catch { return { status: 'operator_attention', reason: 'receipt_invalid' }; }
      if (receipt.phase !== 'ACTIVE') return { status: 'operator_attention', reason: 'effect_unknown' };
      if (receipt.expiresAt > this.now()) return { status: 'active' };
      // Existing port owns the durable ACTIVE->REVOKING CAS BEFORE effects.
      // Never replay a REVOKING receipt or reuse historical REVOKED proof.
      const result = await this.options.port.revoke(receipt.binding, handle, abort.signal); check();
      if (result?.human_input_revoked !== true) return { status: 'operator_attention', reason: 'operation_unconfirmed' };
      return { status: 'expired_revoked' };
    };
    const timeout = new Promise<DaytonaViewerExpiryResult>(resolve => { timer = setTimeout(() => { abort.abort(); resolve({ status: 'operator_attention', reason: 'operation_unconfirmed' }); }, this.deadline); });
    let result: DaytonaViewerExpiryResult;
    try { result = await Promise.race([operation(), timeout]); }
    catch { result = { status: 'operator_attention', reason: 'operation_unconfirmed' }; }
    finally { clearTimeout(timer); abort.abort(); this.inFlight = false; }
    this.checkedAt = this.now(); this.healthy = result.status === 'idle' || result.status === 'active' || result.status === 'expired_revoked';
    return result;
  }
}

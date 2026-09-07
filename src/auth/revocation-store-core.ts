import { hashToken } from '../audit/logger.js';

export interface RevocationState {
  revoked_token_hash: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export type RevocationPersistenceState =
  | 'memory_only'
  | 'initializing'
  | 'ready'
  | 'unavailable'
  | 'stale'
  | 'stale_expired';

export interface RevocationStoreStatus {
  persistence_configured: boolean;
  persistence_required: boolean;
  static_token_auth_ready: boolean;
  state: RevocationPersistenceState;
  last_successful_load_at: string | null;
  last_failed_load_at: string | null;
  last_failed_persist_at: string | null;
  stale_for_ms: number | null;
  max_stale_ms: number;
}

export interface RevocationResult extends RevocationState {
  durability: 'durable' | 'memory_only' | 'failed';
  persisted: boolean;
}

export interface ClearRevocationResult {
  cleared: boolean;
  status: 'cleared_memory_only' | 'durable_clear_disabled';
  persistence_configured: boolean;
  local_revocations_preserved: boolean;
}

export interface RevocationPersistence {
  isConfigured(): boolean;
  query(): Promise<Record<string, unknown>[]>;
  upsert(hash: string, at: string, reason: string): Promise<void>;
}

export interface RevocationStoreOptions {
  /** Explicit local-development escape hatch. Production callers must leave this false. */
  allowMemoryOnly?: boolean | (() => boolean);
  /** Maximum age of the last complete durable snapshot, whether reload fails, hangs, or stops. */
  maxStaleMs?: number;
  /** Maximum complete row set accepted from persistence. The adapter must request one extra row. */
  maxRows?: number;
  now?: () => number;
}

/**
 * In-memory deny-set plus a durable persistence contract.
 *
 * Static tokens remain unavailable until a complete, valid durable read succeeds. A later read
 * failure uses the last known deny-set only for maxStaleMs, then closes static authentication.
 */
export class TokenRevocationStore {
  private readonly revokedHashes = new Set<string>();
  private latest: RevocationState = { revoked_token_hash: null, revoked_at: null, revoked_reason: null };
  private successfulLoad = false;
  private lastSuccessfulLoadAt: string | null = null;
  private lastFailedLoadAt: string | null = null;
  private lastFailedPersistAt: string | null = null;
  private readonly maxStaleMs: number;
  private readonly maxRows: number;
  private readonly now: () => number;

  constructor(
    private readonly persistence: RevocationPersistence,
    private readonly options: RevocationStoreOptions = {},
  ) {
    this.maxStaleMs = options.maxStaleMs ?? 300_000;
    this.maxRows = options.maxRows ?? 1000;
    this.now = options.now ?? Date.now;
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private backendState(): { configured: boolean; memoryOnly: boolean } {
    let configured = false;
    try {
      configured = this.persistence.isConfigured();
    } catch {
      return { configured: false, memoryOnly: false };
    }
    const allowed = typeof this.options.allowMemoryOnly === 'function'
      ? this.options.allowMemoryOnly()
      : Boolean(this.options.allowMemoryOnly);
    return { configured, memoryOnly: !configured && allowed };
  }

  status(): RevocationStoreStatus {
    const backend = this.backendState();
    if (backend.memoryOnly) {
      return {
        persistence_configured: false,
        persistence_required: false,
        static_token_auth_ready: true,
        state: 'memory_only',
        last_successful_load_at: this.lastSuccessfulLoadAt,
        last_failed_load_at: this.lastFailedLoadAt,
        last_failed_persist_at: this.lastFailedPersistAt,
        stale_for_ms: null,
        max_stale_ms: this.maxStaleMs,
      };
    }

    const successfulLoadAge = this.successfulLoad && this.lastSuccessfulLoadAt
      ? Math.max(0, this.now() - Date.parse(this.lastSuccessfulLoadAt))
      : null;
    // Freshness is anchored to the last completed durable read. A pending query never reaches
    // catch, and a stopped timer never calls load(), so failure timestamps alone cannot bound trust.
    const staleExpired = successfulLoadAge !== null && successfulLoadAge >= this.maxStaleMs;
    const staleFor = this.lastFailedLoadAt || staleExpired ? successfulLoadAge : null;
    return {
      persistence_configured: backend.configured,
      persistence_required: true,
      static_token_auth_ready: this.successfulLoad && !staleExpired,
      state: !backend.configured
        ? 'unavailable'
        : !this.successfulLoad
          ? (this.lastFailedLoadAt ? 'unavailable' : 'initializing')
          : staleExpired
            ? 'stale_expired'
            : this.lastFailedLoadAt
              ? 'stale'
              : 'ready',
      last_successful_load_at: this.lastSuccessfulLoadAt,
      last_failed_load_at: this.lastFailedLoadAt,
      last_failed_persist_at: this.lastFailedPersistAt,
      stale_for_ms: staleFor,
      max_stale_ms: this.maxStaleMs,
    };
  }

  async load(): Promise<number> {
    const backend = this.backendState();
    if (backend.memoryOnly) return this.revokedHashes.size;
    if (!backend.configured) {
      this.lastFailedLoadAt = this.isoNow();
      return this.revokedHashes.size;
    }
    try {
      const rows = await this.persistence.query();
      if (rows.length > this.maxRows) {
        throw new Error('revocation result is incomplete');
      }
      const validated = rows.map((row) => {
        const record = row as { hash?: unknown; revoked_at?: unknown; revoked_reason?: unknown };
        if (
          typeof record.hash !== 'string'
          || !/^[a-f0-9]{64}$/.test(record.hash)
          || typeof record.revoked_at !== 'string'
          || !Number.isFinite(Date.parse(record.revoked_at))
          || !(
            record.revoked_reason === undefined
            || record.revoked_reason === null
            || typeof record.revoked_reason === 'string'
          )
        ) {
          throw new Error('malformed revocation record');
        }
        return {
          hash: record.hash,
          at: record.revoked_at,
          reason: typeof record.revoked_reason === 'string' ? record.revoked_reason : null,
        };
      });

      let newestAt = this.latest.revoked_at ?? '';
      let newest = this.latest;
      for (const record of validated) {
        this.revokedHashes.add(record.hash);
        if (record.at > newestAt) {
          newestAt = record.at;
          newest = {
            revoked_token_hash: record.hash,
            revoked_at: record.at,
            revoked_reason: record.reason,
          };
        }
      }
      this.latest = newest;
      this.successfulLoad = true;
      this.lastSuccessfulLoadAt = this.isoNow();
      this.lastFailedLoadAt = null;
      return this.revokedHashes.size;
    } catch {
      this.lastFailedLoadAt = this.isoNow();
      return this.revokedHashes.size;
    }
  }

  async revoke(rawToken: string, reason: string): Promise<RevocationResult> {
    const hash = hashToken(rawToken);
    const at = this.isoNow();
    const revocation: RevocationState = {
      revoked_token_hash: hash,
      revoked_at: at,
      revoked_reason: reason,
    };
    this.revokedHashes.add(hash);
    this.latest = revocation;
    const backend = this.backendState();
    if (backend.memoryOnly) {
      return { ...revocation, durability: 'memory_only', persisted: false };
    }
    if (!backend.configured) {
      this.lastFailedPersistAt = this.isoNow();
      return { ...revocation, durability: 'failed', persisted: false };
    }
    try {
      await this.persistence.upsert(hash, at, reason);
      return { ...revocation, durability: 'durable', persisted: true };
    } catch {
      // Preserve the local deny. Rolling it back could re-enable a token or erase another revoke.
      this.lastFailedPersistAt = this.isoNow();
      return { ...revocation, durability: 'failed', persisted: false };
    }
  }

  isRevoked(rawToken: string): boolean {
    if (this.revokedHashes.size === 0) return false;
    return this.revokedHashes.has(hashToken(rawToken));
  }

  state(): RevocationState {
    return { ...this.latest };
  }

  async clear(): Promise<ClearRevocationResult> {
    const backend = this.backendState();
    if (!backend.memoryOnly) {
      return {
        cleared: false,
        status: 'durable_clear_disabled',
        persistence_configured: backend.configured,
        local_revocations_preserved: true,
      };
    }
    this.revokedHashes.clear();
    this.latest = { revoked_token_hash: null, revoked_at: null, revoked_reason: null };
    return {
      cleared: true,
      status: 'cleared_memory_only',
      persistence_configured: false,
      local_revocations_preserved: false,
    };
  }
}

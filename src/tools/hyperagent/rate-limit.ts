/**
 * Per-lane spend guard for Hyperagent agent invocations.
 *
 * WHY THIS EXISTS. Opening the broker's writes to every internal lane (Matt, 2026-08-19) is safe with
 * respect to ACCESS -- ring.ts decides which agent a lane may address, and that was verified live.
 * What it is not safe against is VOLUME. `create_thread` and `send_message` do not write a row; they
 * make an autonomous agent run, using its own tools and spending account credits. A looping agent, or
 * a retry storm, is therefore a billing event rather than an error, and Hyperagent's rate limits are
 * undocumented, so there is no vendor backstop to rely on.
 *
 * HONEST LIMITATION, stated because a guard that is quietly weaker than it sounds is worse than none:
 * this counter is PER REPLICA and IN MEMORY. At the live replica count the effective ceiling is
 * roughly the configured limit times the number of replicas, and it resets on deploy. It is a
 * runaway-loop bound -- the realistic failure, since a loop lands on one replica -- and NOT a global
 * account quota. A true quota needs the shared store, and belongs with the token-store's ETag'd state
 * rather than bolted on here; if spend ever needs a hard ceiling, that is the change to make.
 */

const WINDOW_MS = 60 * 60 * 1000;

/** Deliberately generous: this is a runaway bound, not a throttle on real work. */
const DEFAULT_LIMIT = 20;

const hits = new Map<string, number[]>();

export function invocationLimit(): number {
  const raw = Number(process.env.HYPERAGENT_MAX_INVOCATIONS_PER_HOUR);
  // Re-read per call so it can be raised without a redeploy, matching the convention the safety
  // modules already use for COLD_START_MODE / JIT_DOCTRINE_MODE.
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LIMIT;
}

export interface RateVerdict {
  allowed: boolean;
  used: number;
  limit: number;
  /** Seconds until the oldest invocation in the window ages out. Only set when refused. */
  retryAfterSeconds?: number;
}

/**
 * Record and evaluate one agent invocation for a lane. Call this ONLY on a path that is about to
 * actually invoke -- after the ring check has passed, so a refused call never consumes budget.
 */
export function checkInvocationBudget(lane: string, now = Date.now()): RateVerdict {
  const key = lane || '(none)';
  const limit = invocationLimit();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= limit) {
    hits.set(key, recent);
    const oldest = recent[0];
    return {
      allowed: false,
      used: recent.length,
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)),
    };
  }

  recent.push(now);
  hits.set(key, recent);
  return { allowed: true, used: recent.length, limit };
}

/** Test seam. Never called in production paths. */
export function __resetInvocationBudgetForTests(): void {
  hits.clear();
}

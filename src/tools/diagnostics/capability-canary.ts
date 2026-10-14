/** Provider-neutral lifecycle for an explicitly scoped, synthetic capability canary.
 * This module deliberately does not select a provider, grant authority, or register an MCP tool.
 */
export type CanaryTarget = { principal: string; account: string; resource: string };

export type CanaryInput = {
  target: CanaryTarget;
  intentId: string;
  idempotencyKey: string;
  payload: unknown;
  now?: () => number;
  deadlineAtMs: number;
  expiresAtMs: number;
};

export type CanarySubmitRequest = Pick<CanaryInput, 'target' | 'intentId' | 'idempotencyKey' | 'payload' | 'expiresAtMs'>;
export type CanaryRecord = { target: CanaryTarget; idempotencyKey: string; payload: unknown; expiresAtMs: number };
export type CanaryProvider = {
  submit(request: CanarySubmitRequest): Promise<{ status: 'submitted' } | { status: 'rejected'; reason: string }>;
  read(target: CanaryTarget, idempotencyKey: string): Promise<{ status: 'found'; record: CanaryRecord } | { status: 'absent' } | { status: 'unreadable'; reason: string }>;
  cleanup(target: CanaryTarget, idempotencyKey: string): Promise<{ status: 'deleted' } | { status: 'failed'; reason: string }>;
};

export type CanaryState = 'expired' | 'deadline_expired' | 'conflict' | 'unknown_frozen' | 'read_unknown_frozen' |
  'wrong_owner_frozen' | 'not_found_frozen' | 'submitted_frozen' | 'confirmed_frozen' | 'cleanup_failed' | 'cleanup_unverified' | 'cleaned' | 'invalid_input';

export type CanaryResult = {
  state: CanaryState;
  target: CanaryTarget;
  intentId: string;
  idempotencyKey: string;
  expiresAtMs: number;
  recovery?: { target: CanaryTarget; intentId: string; idempotencyKey: string; expiresAtMs: number };
  receipts: {
    submitted?: { status: 'submitted' | 'unknown'; atMs: number };
    confirmed?: { status: 'confirmed'; atMs: number };
    cleanup?: { status: 'confirmed' | 'failed' | 'unverified'; atMs: number; reason?: string };
  };
};

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
  if (typeof value !== 'object') throw new TypeError('payload must be lossless JSON');
  if (seen.has(value)) throw new TypeError('payload must not contain cycles');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === 'symbol') || keys.length !== value.length + 1) throw new TypeError('payload arrays must be dense JSON arrays');
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError('payload arrays must not contain holes');
        items.push(canonicalJson(value[index], seen));
      }
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('payload objects must be plain JSON objects');
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) throw new TypeError('payload objects must not contain symbol keys');
    const entries: string[] = [];
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('payload objects must contain enumerable data fields only');
      entries.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, seen)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

type Bounded<T> = { kind: 'value'; value: T } | { kind: 'error' } | { kind: 'timeout' };
function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number): Promise<Bounded<T>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve({ kind: 'timeout' });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Bounded<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    Promise.resolve().then(operation).then(
      (value) => finish({ kind: 'value', value }),
      () => finish({ kind: 'error' }),
    );
  });
}

function result(input: CanaryInput, state: CanaryState, receipts: CanaryResult['receipts'] = {}): CanaryResult {
  return {
    state,
    target: { ...input.target },
    intentId: input.intentId,
    idempotencyKey: input.idempotencyKey,
    expiresAtMs: input.expiresAtMs,
    ...(state === 'unknown_frozen' || state === 'read_unknown_frozen' || state === 'submitted_frozen' || state === 'confirmed_frozen' || state === 'cleanup_failed' || state === 'cleanup_unverified'
      ? { recovery: { target: { ...input.target }, intentId: input.intentId, idempotencyKey: input.idempotencyKey, expiresAtMs: input.expiresAtMs } }
      : {}),
    receipts,
  };
}

/** Executes one bounded attempt. Any ambiguous write freezes this exact target; callers must
 * reconcile it explicitly before another attempt. Cleanup is only attempted after exact readback.
 */
export async function runCapabilityCanary(input: CanaryInput, provider: CanaryProvider): Promise<CanaryResult> {
  const now = input.now ?? Date.now;
  const receipts: CanaryResult['receipts'] = {};
  const initialNow = now();
  if (!Number.isFinite(initialNow) || !Number.isFinite(input.deadlineAtMs) || !Number.isFinite(input.expiresAtMs) ||
      !Number.isFinite(Date.now()) || typeof input.intentId !== 'string' || !input.intentId ||
      typeof input.idempotencyKey !== 'string' || !input.idempotencyKey ||
      !input.target || typeof input.target.principal !== 'string' || !input.target.principal ||
      typeof input.target.account !== 'string' || !input.target.account ||
      typeof input.target.resource !== 'string' || !input.target.resource) {
    return result(input, 'invalid_input');
  }
  let payloadCanonical: string;
  try { payloadCanonical = canonicalJson(input.payload); }
  catch { return result(input, 'invalid_input'); }
  const limitAtMs = Math.min(input.deadlineAtMs, input.expiresAtMs);
  const fresh = () => Number.isFinite(now()) && now() < input.deadlineAtMs && now() < input.expiresAtMs;
  const remainingMs = () => Math.min(limitAtMs - now(), limitAtMs - initialNow);
  if (initialNow >= input.expiresAtMs) return result(input, 'expired');
  if (initialNow >= input.deadlineAtMs) return result(input, 'deadline_expired');
  if (input.expiresAtMs <= initialNow || input.deadlineAtMs <= initialNow) {
    return result(input, 'conflict');
  }

  const submitOutcome = await withDeadline(() => provider.submit({
      target: { ...input.target }, intentId: input.intentId, idempotencyKey: input.idempotencyKey,
      payload: JSON.parse(payloadCanonical), expiresAtMs: input.expiresAtMs,
    }), remainingMs());
  if (submitOutcome.kind !== 'value') {
    receipts.submitted = { status: 'unknown', atMs: now() };
    return result(input, 'unknown_frozen', receipts);
  }
  const submission = submitOutcome.value;
  if (submission.status === 'rejected') return result(input, submission.reason === 'idempotency_conflict' ? 'conflict' : 'unknown_frozen');
  receipts.submitted = { status: 'submitted', atMs: now() };
  if (!fresh()) return result(input, 'submitted_frozen', receipts);

  const readOutcome = await withDeadline(() => provider.read({ ...input.target }, input.idempotencyKey), remainingMs());
  if (readOutcome.kind !== 'value') return result(input, 'read_unknown_frozen', receipts);
  const readback = readOutcome.value;
  if (readback.status === 'unreadable') return result(input, 'read_unknown_frozen', receipts);
  if (readback.status === 'absent') return result(input, 'not_found_frozen', receipts);
  const record = readback.record;
  if (record.target.principal !== input.target.principal || record.target.account !== input.target.account || record.target.resource !== input.target.resource) return result(input, 'wrong_owner_frozen', receipts);
  let readbackPayload: string;
  try { readbackPayload = canonicalJson(record.payload); }
  catch { return result(input, 'conflict', receipts); }
  if (record.idempotencyKey !== input.idempotencyKey || record.expiresAtMs !== input.expiresAtMs || readbackPayload !== payloadCanonical) {
    return result(input, 'conflict', receipts);
  }
  receipts.confirmed = { status: 'confirmed', atMs: now() };
  if (!fresh()) return result(input, 'confirmed_frozen', receipts);

  const cleanupOutcome = await withDeadline(() => provider.cleanup({ ...input.target }, input.idempotencyKey), remainingMs());
  if (cleanupOutcome.kind !== 'value') {
    receipts.cleanup = { status: cleanupOutcome.kind === 'timeout' ? 'unverified' : 'failed', atMs: now(), reason: cleanupOutcome.kind === 'timeout' ? 'cleanup exceeded deadline; provider outcome unknown' : 'cleanup provider error' };
    return result(input, cleanupOutcome.kind === 'timeout' ? 'cleanup_unverified' : 'cleanup_failed', receipts);
  }
  const cleanup = cleanupOutcome.value;
  if (cleanup.status === 'failed') {
    receipts.cleanup = { status: 'failed', atMs: now(), reason: cleanup.reason };
    return result(input, 'cleanup_failed', receipts);
  }
  {
    const afterOutcome = await withDeadline(() => provider.read({ ...input.target }, input.idempotencyKey), remainingMs());
    if (afterOutcome.kind !== 'value') {
      receipts.cleanup = { status: 'unverified', atMs: now(), reason: 'cleanup readback exceeded deadline or failed' };
      return result(input, 'cleanup_unverified', receipts);
    }
    const after = afterOutcome.value;
    if (after.status === 'absent') {
      receipts.cleanup = { status: 'confirmed', atMs: now() };
      return result(input, 'cleaned', receipts);
    }
    receipts.cleanup = { status: 'unverified', atMs: now(), reason: after.status === 'unreadable' ? after.reason : 'canary still present after cleanup' };
  }
  return result(input, 'cleanup_unverified', receipts);
}

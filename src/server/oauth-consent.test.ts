import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SETUP_CODE_ATTEMPTS,
  applyConsentPageHeaders,
  buildAuthorizeRedirectUrl,
  createPendingAuth,
  isValidPendingAuthId,
  newPendingAuthId,
  renderConsentPage,
  renderDeadEndPage,
  resolveElevateChoice,
  resolveReadOnlyChoice,
  type OAuthConsentDeps,
  type PendingAuthDoc,
} from './oauth-consent.js';
import { mintSetupCode, type SetupCodeDeps } from '../auth/setup-codes.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A SHARED fake `cache` store (real ETag CAS semantics) that BOTH the pending-auth deps and the
// setup-code deps point at, so a test can mint a real code + create a real pending record and
// exercise resolveElevateChoice exactly as oauth.ts's POST handler would, all against one
// in-memory backing store -- mirroring tools/heygen/broker.test.ts's convention.
// ─────────────────────────────────────────────────────────────────────────────────────────────
interface FakeRow {
  doc: Record<string, unknown>;
  etag: string;
}

interface FakeCacheStore {
  store: Map<string, FakeRow>;
  create: SetupCodeDeps['create'];
  read: SetupCodeDeps['read'];
  replace: SetupCodeDeps['replace'];
  delete: OAuthConsentDeps['delete'];
}

function makeFakeCacheStore(): FakeCacheStore {
  const store = new Map<string, FakeRow>();
  let etagSeq = 0;
  return {
    store,
    create: (async (_coll, pk, doc) => {
      const id = String((doc as { id: unknown }).id);
      assert.equal(pk, id);
      if (store.has(id)) throw new Error('duplicate id');
      const etag = `E${++etagSeq}`;
      store.set(id, { doc: doc as Record<string, unknown>, etag });
      return { status: 201, ok: true, body: doc, etag };
    }) as SetupCodeDeps['create'],
    read: (async (_coll, pk, id) => {
      assert.equal(pk, id);
      const row = store.get(id);
      return row ? { doc: row.doc, etag: row.etag } : null;
    }) as SetupCodeDeps['read'],
    replace: (async (_coll, pk, id, doc, ifMatch) => {
      assert.equal(pk, id);
      const current = store.get(id);
      if (!current) return { status: 404, ok: false, body: null, etag: null };
      if (ifMatch !== undefined && current.etag !== ifMatch) {
        return { status: 412, ok: false, body: null, etag: null };
      }
      const etag = `E${++etagSeq}`;
      store.set(id, { doc: doc as Record<string, unknown>, etag });
      return { status: 200, ok: true, body: doc, etag };
    }) as SetupCodeDeps['replace'],
    delete: (async (_coll, pk, id) => {
      assert.equal(pk, id);
      const existed = store.delete(id);
      return { status: existed ? 204 : 404, ok: existed, body: null, etag: null };
    }) as OAuthConsentDeps['delete'],
  };
}

let randCounter = 0;
function fixedRandom(): (n: number) => Buffer {
  return (n) => {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i += 1) buf[i] = (i * 53 + randCounter * 11) & 0xff;
    randCounter += 1;
    return buf;
  };
}

function makeDeps(cache: FakeCacheStore, clockRef: { now: number }): { consentDeps: OAuthConsentDeps; setupDeps: SetupCodeDeps } {
  const consentDeps: OAuthConsentDeps = {
    now: () => clockRef.now,
    randomBytesImpl: fixedRandom(),
    create: cache.create,
    read: cache.read,
    replace: cache.replace,
    delete: cache.delete,
    configured: () => true,
  };
  const setupDeps: SetupCodeDeps = {
    now: () => clockRef.now,
    randomBytesImpl: fixedRandom(),
    create: cache.create,
    read: cache.read,
    replace: cache.replace,
    configured: () => true,
  };
  return { consentDeps, setupDeps };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Basic id shape + pending-record CRUD.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('newPendingAuthId is 32 hex chars, and isValidPendingAuthId enforces that exact charset', () => {
  const id = newPendingAuthId((n) => Buffer.alloc(n, 7));
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(isValidPendingAuthId(id), true);
  for (const bad of ['', 'not-hex', 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(31)}Z`, '../../etc/passwd']) {
    assert.equal(isValidPendingAuthId(bad), false, bad);
  }
});

test('createPendingAuth stores a record and returns a valid external id', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps } = makeDeps(cache, clockRef);
  const { id, expiresAt } = await createPendingAuth(
    { clientId: 'dcr_abc', redirectUri: 'https://claude.ai/api/mcp/auth_callback', state: 's1', codeChallenge: 'chal', codeChallengeMethod: 'S256' },
    consentDeps,
  );
  assert.equal(isValidPendingAuthId(id), true);
  assert.ok(Date.parse(expiresAt) > clockRef.now);
  assert.equal(cache.store.size, 1);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TAMPERED / UNKNOWN / EXPIRED pending id -> a clean, non-redirecting 'burned' outcome for BOTH
// choices. Never a store_error, never an 'issue'.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('an unknown pending_id resolves to "burned" (clean 400, no redirect) for the read-only choice', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps } = makeDeps(cache, clockRef);
  const outcome = await resolveReadOnlyChoice('a'.repeat(32), consentDeps);
  assert.deepEqual(outcome, { outcome: 'burned' });
});

test('an unknown pending_id resolves to "burned" (clean 400, no redirect) for the elevate choice too', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps, setupDeps } = makeDeps(cache, clockRef);
  const outcome = await resolveElevateChoice('a'.repeat(32), 'ANY-CODE-AT-ALL', consentDeps, setupDeps);
  assert.deepEqual(outcome, { outcome: 'burned' });
});

test('an EXPIRED pending record resolves to "burned", never "issue"', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps } = makeDeps(cache, clockRef);
  const { id, expiresAt } = await createPendingAuth(
    { clientId: 'dcr_x', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'c', codeChallengeMethod: 'S256' },
    consentDeps,
  );
  clockRef.now = Date.parse(expiresAt) + 1;
  const outcome = await resolveReadOnlyChoice(id, consentDeps);
  assert.deepEqual(outcome, { outcome: 'burned' });
});

test('a genuine store-read failure resolving the pending record is "store_error", never "burned"', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps } = makeDeps(cache, clockRef);
  const failing: OAuthConsentDeps = {
    ...consentDeps,
    read: (async () => {
      throw new Error('ECONNREFUSED');
    }) as OAuthConsentDeps['read'],
  };
  const outcome = await resolveReadOnlyChoice('b'.repeat(32), failing);
  assert.deepEqual(outcome, { outcome: 'store_error' });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// READ-ONLY choice: always agentOverride: null, never touches auth/setup-codes.ts.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('the read-only choice resolves to "issue" with agentOverride: null, and consumes the pending record', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps } = makeDeps(cache, clockRef);
  const { id } = await createPendingAuth(
    { clientId: 'dcr_x', redirectUri: 'https://claude.ai/api/mcp/auth_callback', state: 'st1', codeChallenge: 'chal1', codeChallengeMethod: 'S256' },
    consentDeps,
  );
  const outcome = await resolveReadOnlyChoice(id, consentDeps);
  assert.equal(outcome.outcome, 'issue');
  if (outcome.outcome === 'issue') {
    assert.equal(outcome.agentOverride, null);
    assert.equal(outcome.clientId, 'dcr_x');
    assert.equal(outcome.redirectUri, 'https://claude.ai/api/mcp/auth_callback');
    assert.equal(outcome.state, 'st1');
    assert.equal(outcome.codeChallenge, 'chal1');
  }
  // Single-use cleanup: a second call against the SAME id must now fail.
  const second = await resolveReadOnlyChoice(id, consentDeps);
  assert.deepEqual(second, { outcome: 'burned' });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ELEVATE choice: happy path, wrong-code retry, 5-attempt burn, post-burn refusal even with the
// RIGHT code, and store-failure classification.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a correct setup code resolves to "issue" with agentOverride set to the minted role', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps, setupDeps } = makeDeps(cache, clockRef);
  const minted = await mintSetupCode({ role: 'cfo', createdBy: 'cto' }, setupDeps);
  const { id } = await createPendingAuth(
    { clientId: 'dcr_y', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'chal2', codeChallengeMethod: 'S256' },
    consentDeps,
  );
  const outcome = await resolveElevateChoice(id, minted.code, consentDeps, setupDeps);
  assert.equal(outcome.outcome, 'issue');
  if (outcome.outcome === 'issue') {
    assert.equal(outcome.agentOverride, 'cfo');
    assert.equal(outcome.clientId, 'dcr_y');
  }
});

test('a wrong code returns "retry" and increments the pending record\'s attempt count by exactly one', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps, setupDeps } = makeDeps(cache, clockRef);
  const { id } = await createPendingAuth(
    { clientId: 'dcr_z', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'c3', codeChallengeMethod: 'S256' },
    consentDeps,
  );
  const outcome = await resolveElevateChoice(id, 'WRONG-CODE-AAAA-BBBB', consentDeps, setupDeps);
  assert.deepEqual(outcome, { outcome: 'retry', message: 'That code is invalid or has expired.' });
  const doc = [...cache.store.values()].find((r) => (r.doc as PendingAuthDoc).kind === 'connector-pending-auth')!.doc as PendingAuthDoc;
  assert.equal(doc.attempts, 1);
  assert.equal(doc.burned, false);
});

test('BURN: after MAX_SETUP_CODE_ATTEMPTS wrong guesses the record is burned, and the 6th attempt fails EVEN WITH THE RIGHT CODE', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps, setupDeps } = makeDeps(cache, clockRef);
  const minted = await mintSetupCode({ role: 'clo', createdBy: 'exec' }, setupDeps);
  const { id } = await createPendingAuth(
    { clientId: 'dcr_burn', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'c4', codeChallengeMethod: 'S256' },
    consentDeps,
  );

  for (let i = 1; i < MAX_SETUP_CODE_ATTEMPTS; i += 1) {
    const outcome = await resolveElevateChoice(id, `WRONG-${i}-AAAA-BBBB`, consentDeps, setupDeps);
    assert.deepEqual(outcome, { outcome: 'retry', message: 'That code is invalid or has expired.' }, `attempt ${i} should still be a retry`);
  }
  // The MAX_SETUP_CODE_ATTEMPTS-th wrong guess burns the record.
  const burning = await resolveElevateChoice(id, 'WRONG-FINAL-AAAA-BBBB', consentDeps, setupDeps);
  assert.deepEqual(burning, { outcome: 'burned' });

  // The 6th submission -- even with the objectively CORRECT code -- must still fail. The setup
  // code itself is untouched (still unused), so this proves the refusal comes from the burned
  // pending record, not from the code having been consumed some other way.
  const afterBurn = await resolveElevateChoice(id, minted.code, consentDeps, setupDeps);
  assert.deepEqual(afterBurn, { outcome: 'burned' });

  // And the code is provably still valid/unused: a FRESH pending record can still redeem it.
  const { id: freshId } = await createPendingAuth(
    { clientId: 'dcr_burn2', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'c5', codeChallengeMethod: 'S256' },
    consentDeps,
  );
  const freshOutcome = await resolveElevateChoice(freshId, minted.code, consentDeps, setupDeps);
  assert.equal(freshOutcome.outcome, 'issue');
  if (freshOutcome.outcome === 'issue') assert.equal(freshOutcome.agentOverride, 'clo');
});

test('a store failure classified as store_unavailable from consumeSetupCode maps to store_error, not a burned attempt', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps, setupDeps } = makeDeps(cache, clockRef);
  const { id } = await createPendingAuth(
    { clientId: 'dcr_se', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'c6', codeChallengeMethod: 'S256' },
    consentDeps,
  );
  const failingSetupDeps: SetupCodeDeps = {
    ...setupDeps,
    read: (async () => {
      throw new Error('db down');
    }) as SetupCodeDeps['read'],
  };
  const outcome = await resolveElevateChoice(id, 'ANY-CODE-WHATEVER-01', consentDeps, failingSetupDeps);
  assert.deepEqual(outcome, { outcome: 'store_error' });
  // Fail-loud, not fail-open: the pending record's attempts must NOT have been silently burned by
  // a storage error masquerading as a wrong guess.
  const doc = [...cache.store.values()].find((r) => (r.doc as PendingAuthDoc).kind === 'connector-pending-auth')!.doc as PendingAuthDoc;
  assert.equal(doc.attempts, 0);
});

test('a storage failure WRITING the attempts-increment is store_error, never a silent retry', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps, setupDeps } = makeDeps(cache, clockRef);
  const { id } = await createPendingAuth(
    { clientId: 'dcr_wf', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'c7', codeChallengeMethod: 'S256' },
    consentDeps,
  );
  const failingConsentDeps: OAuthConsentDeps = {
    ...consentDeps,
    replace: (async () => {
      throw new Error('write timeout');
    }) as OAuthConsentDeps['replace'],
  };
  const outcome = await resolveElevateChoice(id, 'WRONG-CODE-CCCC-DDDD', failingConsentDeps, setupDeps);
  assert.deepEqual(outcome, { outcome: 'store_error' });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// MULTI-REPLICA RACE on the pending record's OWN attempts CAS: two concurrent wrong guesses
// against the SAME pending id must not both land as "attempt 1 of 5".
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('two concurrent wrong-code submissions against the SAME pending id both count, landing at attempts=2', async () => {
  const cache = makeFakeCacheStore();
  const clockRef = { now: 1_000_000 };
  const { consentDeps, setupDeps } = makeDeps(cache, clockRef);
  const { id } = await createPendingAuth(
    { clientId: 'dcr_race', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'c8', codeChallengeMethod: 'S256' },
    consentDeps,
  );

  const [r1, r2] = await Promise.all([
    resolveElevateChoice(id, 'WRONG-A-AAAA-AAAA', consentDeps, setupDeps),
    resolveElevateChoice(id, 'WRONG-B-BBBB-BBBB', consentDeps, setupDeps),
  ]);
  for (const r of [r1, r2]) {
    assert.deepEqual(r, { outcome: 'retry', message: 'That code is invalid or has expired.' });
  }
  const doc = [...cache.store.values()].find((r) => (r.doc as PendingAuthDoc).kind === 'connector-pending-auth')!.doc as PendingAuthDoc;
  assert.equal(doc.attempts, 2, 'both concurrent wrong guesses must be counted, not collapsed into one');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// HTML rendering: pure functions, escaping.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('renderConsentPage embeds the pending_id, both action buttons, and (when given) an escaped error', () => {
  const page = renderConsentPage('deadbeefdeadbeefdeadbeefdeadbeef');
  assert.match(page, /name="pending_id" value="deadbeefdeadbeefdeadbeefdeadbeef"/);
  assert.match(page, /name="action" value="readonly"/);
  assert.match(page, /name="action" value="elevate"/);
  assert.match(page, /A connector is requesting access to the OTCHealth gateway/);

  const withError = renderConsentPage('deadbeefdeadbeefdeadbeefdeadbeef', 'That code is invalid or has expired.');
  assert.match(withError, /That code is invalid or has expired\./);
});

test('renderConsentPage HTML-escapes whatever it is given, even though pending_id is never attacker-controlled in production', () => {
  const page = renderConsentPage('"><script>alert(1)</script>', '<img onerror=alert(1) src=x>');
  assert.equal(page.includes('<script>alert(1)</script>'), false);
  assert.equal(page.includes('<img onerror=alert(1) src=x>'), false);
  assert.match(page, /&lt;script&gt;/);
  assert.match(page, /&lt;img onerror=alert\(1\) src=x&gt;/);
});

test('renderDeadEndPage renders distinct wording for expired vs server_error, with no form', () => {
  const expired = renderDeadEndPage('expired');
  const serverError = renderDeadEndPage('server_error');
  assert.match(expired, /expired/i);
  assert.match(serverError, /wrong/i);
  assert.equal(expired.includes('<form'), false);
  assert.equal(serverError.includes('<form'), false);
});

test('applyConsentPageHeaders sets the expected no-store / CSP / frame headers', () => {
  const calls: Array<[string, string]> = [];
  let typeCall = '';
  const fakeReply = {
    header: (name: string, value: string) => {
      calls.push([name, value]);
      return fakeReply;
    },
    type: (value: string) => {
      typeCall = value;
      return fakeReply;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  applyConsentPageHeaders(fakeReply);
  const asMap = Object.fromEntries(calls);
  assert.equal(asMap['cache-control'], 'no-store');
  assert.equal(asMap['x-frame-options'], 'DENY');
  assert.equal(asMap['x-content-type-options'], 'nosniff');
  assert.equal(asMap['referrer-policy'], 'no-referrer');
  assert.match(asMap['content-security-policy'], /default-src 'none'/);
  assert.equal(typeCall, 'text/html; charset=utf-8');
});

test('buildAuthorizeRedirectUrl appends code and, when present, state', () => {
  const withState = buildAuthorizeRedirectUrl('https://claude.ai/api/mcp/auth_callback', 'CODE123', 'STATE1');
  const url1 = new URL(withState);
  assert.equal(url1.searchParams.get('code'), 'CODE123');
  assert.equal(url1.searchParams.get('state'), 'STATE1');

  const withoutState = buildAuthorizeRedirectUrl('https://claude.ai/api/mcp/auth_callback', 'CODE456', null);
  const url2 = new URL(withoutState);
  assert.equal(url2.searchParams.get('code'), 'CODE456');
  assert.equal(url2.searchParams.has('state'), false);
});

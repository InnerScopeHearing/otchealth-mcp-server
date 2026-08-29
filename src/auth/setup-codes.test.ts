import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ELEVATION_ROLES,
  SetupCodeError,
  clampTtlMinutes,
  consumeSetupCode,
  generateSetupCodePlaintext,
  hashSetupCode,
  isElevationRole,
  mintSetupCode,
  normalizeSetupCode,
  type ElevationRole,
  type SetupCodeDeps,
} from './setup-codes.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fake in-memory `cache` store with REAL ETag optimistic-concurrency semantics, mirroring
// tools/heygen/broker.test.ts's convention (see that file's fakeHeyGenDeps helper) so the
// multi-replica race test below exercises the ACTUAL compare-and-swap logic in setup-codes.ts,
// not a mocked-away version of it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
interface FakeRow {
  doc: Record<string, unknown>;
  etag: string;
}

interface FakeDeps {
  deps: SetupCodeDeps;
  store: Map<string, FakeRow>;
  createCalls: () => number;
  advanceClockTo: (ms: number) => void;
}

function fakeDeps(overrides: Partial<SetupCodeDeps> = {}): FakeDeps {
  const store = new Map<string, FakeRow>();
  let etagSeq = 0;
  let createCalls = 0;
  let clock = 1_000_000;
  const deps: SetupCodeDeps = {
    now: () => clock,
    randomBytesImpl: (n) => {
      // Deterministic-looking but non-repeating: a per-call counter mixed into each byte so
      // distinct codes are generated across repeated calls within one test (needed for the
      // "code X != code Y" and retry-on-collision paths), while staying fully reproducible.
      const buf = Buffer.alloc(n);
      for (let i = 0; i < n; i += 1) buf[i] = (i * 37 + etagSeq * 7) & 0xff;
      etagSeq += 1;
      return buf;
    },
    create: (async (_coll, pk, doc) => {
      createCalls += 1;
      const id = String((doc as { id: unknown }).id);
      assert.equal(pk, id, 'partition key must equal the doc id (single-partition-per-doc convention)');
      if (store.has(id)) {
        throw new Error('Postgres createDoc cache -> 409: duplicate id');
      }
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
    configured: () => true,
    ...overrides,
  };
  return {
    deps,
    store,
    createCalls: () => createCalls,
    advanceClockTo: (ms: number) => {
      clock = ms;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Role allowlist: clo-personal is permanently unmintable; nothing outside ELEVATION_ROLES mints.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('ELEVATION_ROLES is exactly the six named roles, and clo-personal is not among them', () => {
  assert.deepEqual([...ELEVATION_ROLES].sort(), ['cfo', 'clo', 'coo', 'cro', 'cto', 'developer'].sort());
  assert.equal((ELEVATION_ROLES as readonly string[]).includes('clo-personal'), false);
});

test('isElevationRole accepts exactly the six roles and rejects everything else, including clo-personal', () => {
  for (const role of ELEVATION_ROLES) assert.equal(isElevationRole(role), true, role);
  for (const bad of ['clo-personal', 'exec', 'cpo', 'cco', 'admin', '', 'CTO', 'cto ']) {
    assert.equal(isElevationRole(bad), false, bad);
  }
});

test('SAFETY-CRITICAL: mintSetupCode refuses clo-personal with a NAMED error, BEFORE touching storage', async () => {
  const { deps, createCalls } = fakeDeps();
  await assert.rejects(
    () => mintSetupCode({ role: 'clo-personal', createdBy: 'cto' }, deps),
    (e: unknown) => e instanceof SetupCodeError && e.code === 'role_not_mintable',
  );
  assert.equal(createCalls(), 0, 'no doc should ever be created for a refused role');
});

test('mintSetupCode refuses any role outside ELEVATION_ROLES (not just clo-personal)', async () => {
  const { deps, createCalls } = fakeDeps();
  for (const bad of ['exec', 'cpo', 'cco', 'admin', '', 'CTO']) {
    await assert.rejects(
      () => mintSetupCode({ role: bad, createdBy: 'cto' }, deps),
      (e: unknown) => e instanceof SetupCodeError && e.code === 'role_not_mintable',
      `expected "${bad}" to be refused`,
    );
  }
  assert.equal(createCalls(), 0);
});

test('mintSetupCode refuses to mint when the shared store is not configured', async () => {
  const { deps } = fakeDeps({ configured: () => false });
  await assert.rejects(
    () => mintSetupCode({ role: 'cfo', createdBy: 'cto' }, deps),
    (e: unknown) => e instanceof SetupCodeError && e.code === 'setup_code_store_unavailable',
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Mint shape: entropy, alphabet, normalization.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('generateSetupCodePlaintext uses the exact 32-symbol Crockford alphabet (no I/L/O/U), grouped in 4s, unbiased', () => {
  const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 61) & 0xff));
  const code = generateSetupCodePlaintext(bytes);
  assert.match(code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  for (const excluded of ['I', 'L', 'O', 'U']) {
    assert.equal(code.includes(excluded), false, `code must never contain excluded character "${excluded}": ${code}`);
  }
  // Bias regression lock (the CodeQL js/biased-cryptographic-random finding on this PR): with a
  // full 0..255 byte sweep, an EXACTLY-32-symbol alphabet indexed by `b & 31` must select every
  // symbol exactly 8 times (256 / 32). The pre-fix 31-character alphabet cannot pass this: its
  // `% 31` mapping selects the first 8 symbols 9 times each.
  const counts = new Map<string, number>();
  for (let start = 0; start < 256; start += 16) {
    const chunk = generateSetupCodePlaintext(() => Buffer.from(Array.from({ length: 16 }, (_, i) => start + i)));
    for (const ch of chunk.replace(/-/g, '')) counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  assert.equal(counts.size, 32, 'a 0..255 sweep must reach all 32 symbols');
  for (const [ch, n] of counts) assert.equal(n, 8, `symbol "${ch}" selected ${n} times; an unbiased power-of-two mapping selects each exactly 8 times`);
});

test('normalizeSetupCode is case-insensitive, punctuation-tolerant, and maps Crockford confusables (O->0, I/L->1)', () => {
  const canonical = 'ABCD-EFGH-JKMN-PQRS';
  const messy = ` ${canonical.toLowerCase().replace(/-/g, ' ')} `;
  assert.equal(normalizeSetupCode(messy), normalizeSetupCode(canonical));
  assert.equal(normalizeSetupCode('ab-CD 12'), 'ABCD12');
  assert.equal(normalizeSetupCode('AB!!CD??12'), 'ABCD12');
  // A human who misreads 0 as O, or 1 as I or l, still produces the identical hash input.
  assert.equal(normalizeSetupCode('O1IL-oQR2'), '0111-0QR2'.replace('-', ''));
  assert.equal(normalizeSetupCode('COOL-CAT1'), normalizeSetupCode('C00L-CAT1'.replace('L', '1')));
});

test('hashSetupCode is deterministic and produces a 64-hex-char sha256 digest', () => {
  const h1 = hashSetupCode('ABCD1234');
  const h2 = hashSetupCode('ABCD1234');
  assert.equal(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
  assert.notEqual(h1, hashSetupCode('ABCD1235'));
});

test('clampTtlMinutes: unset defaults to 30, and out-of-range values clamp to [1, 1440]', () => {
  assert.equal(clampTtlMinutes(undefined), 30);
  assert.equal(clampTtlMinutes(0), 1);
  assert.equal(clampTtlMinutes(-5), 1);
  assert.equal(clampTtlMinutes(45), 45);
  assert.equal(clampTtlMinutes(9999), 1440);
  assert.equal(clampTtlMinutes(1440), 1440);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Mint -> consume round trip, per role. A code minted for role X can never yield role Y.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('mint -> consume round trip yields EXACTLY the minted role, for every elevation-eligible role', async () => {
  for (const role of ELEVATION_ROLES) {
    const { deps } = fakeDeps();
    const minted = await mintSetupCode({ role, createdBy: 'cto', label: `test ${role}` }, deps);
    assert.equal(minted.role, role);
    const consumed = await consumeSetupCode(minted.code, deps);
    assert.deepEqual(consumed, { ok: true, role });
  }
});

test('minting for role X and consuming a DIFFERENT (never-minted) code never yields role X', async () => {
  const { deps } = fakeDeps();
  await mintSetupCode({ role: 'cfo', createdBy: 'cto' }, deps);
  const consumed = await consumeSetupCode('TOTALLY-WRONG-CODE-VALUE', deps);
  assert.deepEqual(consumed, { ok: false, reason: 'invalid_or_expired' });
});

test('an unknown code and a wrong guess are indistinguishable: both are invalid_or_expired', async () => {
  const { deps } = fakeDeps();
  const neverMinted = await consumeSetupCode('NEVER-MINTED-CODE-000', deps);
  assert.deepEqual(neverMinted, { ok: false, reason: 'invalid_or_expired' });
  const empty = await consumeSetupCode('', deps);
  assert.deepEqual(empty, { ok: false, reason: 'invalid_or_expired' });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Single-use enforcement: a code can be consumed EXACTLY once.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('SINGLE-USE: consuming an already-used code fails, even with the exact right text', async () => {
  const { deps } = fakeDeps();
  const minted = await mintSetupCode({ role: 'clo', createdBy: 'cto' }, deps);
  const first = await consumeSetupCode(minted.code, deps);
  assert.deepEqual(first, { ok: true, role: 'clo' });
  const replay = await consumeSetupCode(minted.code, deps);
  assert.deepEqual(replay, { ok: false, reason: 'invalid_or_expired' });
});

test('REPLAY: normalization variants of an already-used code also fail (not a bypass of single-use)', async () => {
  const { deps } = fakeDeps();
  const minted = await mintSetupCode({ role: 'coo', createdBy: 'cto' }, deps);
  await consumeSetupCode(minted.code, deps);
  const lower = minted.code.toLowerCase().replace(/-/g, ' ');
  const replay = await consumeSetupCode(lower, deps);
  assert.deepEqual(replay, { ok: false, reason: 'invalid_or_expired' });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Expiry.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('EXPIRED: a code past its TTL fails to consume even though it was never used', async () => {
  const fake = fakeDeps();
  const minted = await mintSetupCode({ role: 'cro', createdBy: 'cto', ttlMinutes: 5 }, fake.deps);
  const expiresMs = Date.parse(minted.expiresAt);
  fake.advanceClockTo(expiresMs + 1); // exactly past expiry
  const consumed = await consumeSetupCode(minted.code, fake.deps);
  assert.deepEqual(consumed, { ok: false, reason: 'invalid_or_expired' });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// MULTI-REPLICA RACE: two concurrent consumers of the SAME code -> exactly one success.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('MULTI-REPLICA RACE: two concurrent consumeSetupCode calls for the SAME code yield exactly one success', async () => {
  const { deps } = fakeDeps();
  const minted = await mintSetupCode({ role: 'developer', createdBy: 'cto' }, deps);

  const [r1, r2] = await Promise.all([consumeSetupCode(minted.code, deps), consumeSetupCode(minted.code, deps)]);

  const results = [r1, r2];
  const successes = results.filter((r) => r.ok);
  const failures = results.filter((r) => !r.ok);
  assert.equal(successes.length, 1, 'exactly one of the two racing consumers must succeed');
  assert.equal(failures.length, 1, 'exactly one of the two racing consumers must fail');
  assert.equal((successes[0] as { ok: true; role: ElevationRole }).role, 'developer');
  assert.deepEqual(failures[0], { ok: false, reason: 'invalid_or_expired' });
});

test('MULTI-REPLICA RACE, wider: five concurrent consumers of the SAME code -> exactly one success', async () => {
  const { deps } = fakeDeps();
  const minted = await mintSetupCode({ role: 'cto', createdBy: 'exec' }, deps);
  const results = await Promise.all(Array.from({ length: 5 }, () => consumeSetupCode(minted.code, deps)));
  assert.equal(results.filter((r) => r.ok).length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Store-failure classification: distinct from a wrong/expired code.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a store read failure during consumption reports store_unavailable, not invalid_or_expired', async () => {
  const { deps } = fakeDeps({
    read: (async () => {
      throw new Error('ECONNREFUSED');
    }) as SetupCodeDeps['read'],
  });
  const consumed = await consumeSetupCode('ANYTHING-AT-ALL-0000', deps);
  assert.deepEqual(consumed, { ok: false, reason: 'store_unavailable' });
});

test('an unconfigured store reports store_unavailable on consume', async () => {
  const { deps } = fakeDeps({ configured: () => false });
  const consumed = await consumeSetupCode('ANYTHING-AT-ALL-0000', deps);
  assert.deepEqual(consumed, { ok: false, reason: 'store_unavailable' });
});

test('a store failure during the replace(ifMatch) write reports store_unavailable', async () => {
  const { deps: baseDeps, store } = fakeDeps();
  const minted = await mintSetupCode({ role: 'cfo', createdBy: 'cto' }, baseDeps);
  assert.equal(store.size, 1);
  const failingDeps: SetupCodeDeps = {
    ...baseDeps,
    replace: (async () => {
      throw new Error('write timeout');
    }) as SetupCodeDeps['replace'],
  };
  const consumed = await consumeSetupCode(minted.code, failingDeps);
  assert.deepEqual(consumed, { ok: false, reason: 'store_unavailable' });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Label handling (non-security, but a real input path).
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('label is trimmed, capped at 200 chars, and null when omitted or blank', async () => {
  const { deps, store } = fakeDeps();
  const noLabel = await mintSetupCode({ role: 'cfo', createdBy: 'cto' }, deps);
  const doc1 = [...store.values()].find((r) => (r.doc as { codeHash: string }).codeHash === hashSetupCode(normalizeSetupCode(noLabel.code)));
  assert.equal((doc1!.doc as { label: unknown }).label, null);

  const blank = await mintSetupCode({ role: 'cfo', createdBy: 'cto', label: '   ' }, deps);
  const doc2 = [...store.values()].find((r) => (r.doc as { codeHash: string }).codeHash === hashSetupCode(normalizeSetupCode(blank.code)));
  assert.equal((doc2!.doc as { label: unknown }).label, null);

  const long = 'x'.repeat(500);
  const withLabel = await mintSetupCode({ role: 'cfo', createdBy: 'cto', label: long }, deps);
  const doc3 = [...store.values()].find((r) => (r.doc as { codeHash: string }).codeHash === hashSetupCode(normalizeSetupCode(withLabel.code)));
  assert.equal(((doc3!.doc as { label: string }).label).length, 200);
});

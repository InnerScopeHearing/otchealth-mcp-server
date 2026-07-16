import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Satisfy loadEnv()'s required vars BEFORE the first loadEnv call (same preamble as
// brain-search.test.ts), plus the Xero + Cosmos config the token manager reads.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.XERO_CLIENT_ID ||= 'test-client-id';
process.env.XERO_CLIENT_SECRET ||= 'test-client-secret';
process.env.XERO_RT_OTCHEALTH ||= 'bootstrap-rt-otchealth';
process.env.COSMOS_ENDPOINT ||= 'https://test.documents.azure.com';
process.env.COSMOS_DB ||= 'test';
process.env.COSMOS_KEY ||= Buffer.from('test-key').toString('base64');

const {
  isXeroAllowed,
  tokenDocId,
  bootstrapHash,
  buildTokenDoc,
  getOrgAccess,
  XERO_ORGS,
} = await import('./client.js');
const { EXEC_RING } = await import('../kb/search-privileged.js');

// Exact-hostname match for the mock fetch routers below. Parsing the URL and comparing hostname
// (rather than a substring .includes) is the sanctioned fix for CodeQL's "incomplete URL substring
// sanitization" query — and it is simply the correct way to route a stubbed fetch by host anyway.
const isHost = (u: string | URL, host: string): boolean => {
  try {
    return new URL(String(u)).hostname === host;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------
// RING LOCK — xero_* is MNPI; exactly the executive ring, nothing else, single source of truth.
// ---------------------------------------------------------------------------------------------

test('SAFETY-CRITICAL: every EXEC_RING lane is allowed; cto/default/developer/external/empty are refused', () => {
  for (const lane of EXEC_RING) assert.equal(isXeroAllowed(lane), true, `${lane} must reach xero_*`);
  for (const lane of ['cto', 'default', 'developer', 'external-read', 'iheartest', 'focus-group', 'nope', '']) {
    assert.equal(isXeroAllowed(lane), false, `${lane || '(empty)'} must NEVER reach xero_* (MNPI)`);
  }
  assert.equal(isXeroAllowed(undefined), false);
  assert.equal(isXeroAllowed(null), false);
});

// ---------------------------------------------------------------------------------------------
// TOKEN DOC — the persisted chain doc. ttl:-1 is LOAD-BEARING (cache container has a 7-day
// default TTL; an expiring token doc = a lost refresh chain = human re-consent).
// ---------------------------------------------------------------------------------------------

test('SAFETY-CRITICAL: the token doc pins ttl:-1 so the cache container TTL can never expire the chain', () => {
  const doc = buildTokenDoc({
    org: 'otchealth',
    refreshToken: 'rt',
    accessToken: 'at',
    expiresInSeconds: 1800,
    tenantId: 't',
    tenantName: 'OTCHealth Inc.',
    bootstrapHash: 'h',
  });
  assert.equal(doc.ttl, -1, 'ttl must be -1 (never expire); anything else silently kills the chain in 7 days');
  assert.equal(doc.status, 'live');
  assert.ok(doc.expiresAt > Date.now() && doc.expiresAt <= Date.now() + 1800_000, 'expiresAt carries the margin');
});

test('SAFETY-CRITICAL (B1): the token doc carries cacheScope === its id, the /cacheScope partition key of the `cache` container', () => {
  // Without this field Cosmos extracts partition key `undefined`, mismatches the header, and 400s
  // EVERY persist — silently burning the single-use bootstrap consent on the first call.
  for (const org of XERO_ORGS) {
    const doc = buildTokenDoc({
      org, refreshToken: 'rt', accessToken: 'at', expiresInSeconds: 1800,
      tenantId: 't', tenantName: 'n', bootstrapHash: 'h',
    });
    assert.equal(doc.cacheScope, doc.id, `${org}: cacheScope must equal id (the pk we pass to Cosmos)`);
    assert.equal(doc.cacheScope, tokenDocId(org));
  }
});

test('tokenDocId uses the Cosmos-legal id charset for every org (no colons)', () => {
  for (const org of XERO_ORGS) {
    const id = tokenDocId(org);
    assert.match(id, /^[A-Za-z0-9_.\-]{1,255}$/, `${id} must satisfy the cosmos.ts ID_RE`);
  }
});

test('bootstrapHash is stable and never echoes the secret', () => {
  const h = bootstrapHash('super-secret-refresh-token');
  assert.equal(h, bootstrapHash('super-secret-refresh-token'));
  assert.equal(h.length, 32);
  assert.ok(!h.includes('super-secret'), 'hash must not contain secret material');
});

// ---------------------------------------------------------------------------------------------
// ROTATION STATE MACHINE — deps-injected; no real Cosmos or Xero.
// ---------------------------------------------------------------------------------------------

type AnyDoc = Record<string, unknown>;

function grantResponse(n: number): Response {
  return new Response(
    JSON.stringify({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 1800 }),
    { status: 200 },
  );
}
function connectionsResponse(): Response {
  return new Response(JSON.stringify([{ tenantId: 'tenant-1', tenantName: 'OTCHealth Inc.' }]), { status: 200 });
}

function makeDeps(state: { doc: AnyDoc | null; etag: string | null }) {
  const calls: string[] = [];
  let grantN = 0;
  const deps = {
    fetchImpl: (async (url: string | URL) => {
      const u = String(url);
      if (isHost(u, 'identity.xero.com')) {
        calls.push('grant');
        grantN += 1;
        return grantResponse(grantN);
      }
      if (isHost(u, 'api.xero.com')) {
        calls.push('connections');
        return connectionsResponse();
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch,
    read: (async () => (state.doc ? { doc: state.doc, etag: state.etag } : null)) as never,
    replace: (async (_c: string, _p: string, _i: string, doc: AnyDoc, _ifMatch?: string) => {
      calls.push('persist:replace');
      state.doc = doc;
      state.etag = 'etag-2';
      return { ok: true, status: 200, body: doc, etag: 'etag-2' };
    }) as never,
    create: (async (_c: string, _p: string, doc: AnyDoc) => {
      calls.push('persist:create');
      state.doc = doc;
      state.etag = 'etag-1';
      return { ok: true, status: 201, body: doc, etag: 'etag-1' };
    }) as never,
    upsert: (async (_c: string, _p: string, doc: AnyDoc) => {
      calls.push('persist:upsert');
      state.doc = doc;
      return { ok: true, status: 200, body: doc, etag: 'etag-x' };
    }) as never,
  };
  return { deps: deps as never, calls };
}

test('first use bootstraps from the env secret, PERSISTS the new chain, and returns the access token', async () => {
  const state = { doc: null as AnyDoc | null, etag: null as string | null };
  const { deps, calls } = makeDeps(state);
  const a = await getOrgAccess('otchealth', { deps });
  assert.equal(a.accessToken, 'at-1');
  assert.equal(a.tenantId, 'tenant-1');
  assert.ok(calls.includes('persist:create'), 'chain must be persisted');
  assert.ok(
    calls.indexOf('persist:create') > calls.indexOf('grant'),
    'persist happens after the grant (it stores the NEW token)',
  );
  assert.equal((state.doc as AnyDoc).refreshToken, 'rt-1', 'the ROTATED refresh token is what gets stored');
  assert.equal((state.doc as AnyDoc).ttl, -1);
});

test('a fresh cached access token short-circuits: no grant call, no rotation', async () => {
  const live = buildTokenDoc({
    org: 'otchealth',
    refreshToken: 'rt-live',
    accessToken: 'at-live',
    expiresInSeconds: 1800,
    tenantId: 'tenant-1',
    tenantName: 'OTCHealth Inc.',
    bootstrapHash: bootstrapHash(process.env.XERO_RT_OTCHEALTH as string),
  });
  const state = { doc: live as AnyDoc, etag: 'etag-1' };
  const { deps, calls } = makeDeps(state);
  const a = await getOrgAccess('otchealth', { deps });
  assert.equal(a.accessToken, 'at-live');
  assert.equal(calls.length, 0, 'no network, no rotation');
});

test('a CHANGED bootstrap secret supersedes the stored chain (operator re-consent path)', async () => {
  const stale = buildTokenDoc({
    org: 'otchealth',
    refreshToken: 'rt-old-chain',
    accessToken: 'at-old',
    expiresInSeconds: 1800,
    tenantId: 'tenant-1',
    tenantName: 'OTCHealth Inc.',
    bootstrapHash: 'hash-of-a-DIFFERENT-secret',
  });
  const state = { doc: stale as AnyDoc, etag: 'etag-1' };
  const { deps, calls } = makeDeps(state);
  const a = await getOrgAccess('otchealth', { deps });
  // Chain restarted from the env bootstrap: a grant ran and the stored doc was REPLACED (B2) — NOT
  // created against the still-existing superseded doc (which would 409 and burn the new consent).
  assert.ok(calls.includes('grant'));
  assert.ok(calls.includes('persist:replace'), 'B2: re-consent must supersede via REPLACE (keep the etag)');
  assert.ok(!calls.includes('persist:create'), 'B2: must NOT create over the existing superseded doc');
  assert.equal(a.accessToken, 'at-1');
  assert.equal((state.doc as AnyDoc).bootstrapHash, bootstrapHash(process.env.XERO_RT_OTCHEALTH as string));
});

test('losing the ETag race adopts the WINNER chain and never persists the fork', async () => {
  const expired = buildTokenDoc({
    org: 'otchealth',
    refreshToken: 'rt-shared',
    accessToken: 'at-expired',
    expiresInSeconds: 0, // already past the margin -> forces a refresh
    tenantId: 'tenant-1',
    tenantName: 'OTCHealth Inc.',
    bootstrapHash: bootstrapHash(process.env.XERO_RT_OTCHEALTH as string),
  });
  const winner = buildTokenDoc({
    org: 'otchealth',
    refreshToken: 'rt-winner',
    accessToken: 'at-winner',
    expiresInSeconds: 1800,
    tenantId: 'tenant-1',
    tenantName: 'OTCHealth Inc.',
    bootstrapHash: bootstrapHash(process.env.XERO_RT_OTCHEALTH as string),
  });
  let reads = 0;
  const calls: string[] = [];
  const deps = {
    fetchImpl: (async (url: string | URL) => {
      const u = String(url);
      if (isHost(u, 'identity.xero.com')) {
        calls.push('grant');
        return grantResponse(99);
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch,
    read: (async () => {
      reads += 1;
      // 1st read: the expired doc. 2nd read (after 412): the winner's fresh doc.
      return reads === 1 ? { doc: expired, etag: 'etag-old' } : { doc: winner, etag: 'etag-new' };
    }) as never,
    replace: (async () => {
      calls.push('replace-412');
      return { ok: false, status: 412, body: {}, etag: null };
    }) as never,
    create: (async () => {
      throw new Error('create must not be called when a doc exists');
    }) as never,
    upsert: (async () => ({ ok: true, status: 200, body: {}, etag: null })) as never,
  };
  const a = await getOrgAccess('otchealth', { deps: deps as never });
  assert.equal(a.accessToken, 'at-winner', 'the loser must adopt the winner chain');
  assert.ok(!calls.includes('persist:create') && !calls.includes('persist:upsert'), 'the fork is never persisted');
});

test('invalid_grant on first use dead-marks via CREATE (no doc), with an actionable error and NO token material', async () => {
  const state = { doc: null as AnyDoc | null, etag: null as string | null };
  const created: AnyDoc[] = [];
  const deps = {
    fetchImpl: (async (url: string | URL) => {
      if (isHost(url, 'identity.xero.com')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    read: (async () => (state.doc ? { doc: state.doc, etag: state.etag } : null)) as never,
    replace: (async () => {
      throw new Error('replace must not be called when no doc exists');
    }) as never,
    create: (async (_c: string, _p: string, doc: AnyDoc) => {
      created.push(doc);
      state.doc = doc;
      return { ok: true, status: 201, body: doc, etag: 'etag-dead' };
    }) as never,
  };
  await assert.rejects(
    () => getOrgAccess('otchealth', { deps: deps as never }),
    (e: Error) => /re-consent/.test(e.message) && /XERO_RT_OTCHEALTH/.test(e.message),
    'the error must tell the operator exactly what to do',
  );
  assert.equal(created.length, 1, 'a dead tombstone is created');
  assert.equal(created[0].status, 'dead');
  assert.equal(created[0].refreshToken, '', 'no token material in the tombstone');
  assert.equal(created[0].accessToken, '');
  assert.equal(created[0].cacheScope, created[0].id, 'the tombstone MUST carry the /cacheScope partition key');
});

test('SAFETY-CRITICAL (B3): invalid_grant NEVER clobbers a concurrent live winner — it adopts it instead of dead-marking', async () => {
  // A same-family doc is expired -> we refresh with its (now superseded) chain token and get
  // invalid_grant. Meanwhile another replica rotated a fresh live chain. The dead-mark path must
  // re-read, see the live winner, and RETURN it — never overwrite it with a tombstone.
  const bHash = bootstrapHash(process.env.XERO_RT_OTCHEALTH as string);
  const expired = buildTokenDoc({
    org: 'otchealth', refreshToken: 'rt-superseded', accessToken: 'at-expired', expiresInSeconds: 0,
    tenantId: 'tenant-1', tenantName: 'OTCHealth Inc.', bootstrapHash: bHash,
  });
  const winner = buildTokenDoc({
    org: 'otchealth', refreshToken: 'rt-winner', accessToken: 'at-winner', expiresInSeconds: 1800,
    tenantId: 'tenant-1', tenantName: 'OTCHealth Inc.', bootstrapHash: bHash,
  });
  let reads = 0;
  let wrote = false;
  const deps = {
    fetchImpl: (async (url: string | URL) => {
      if (isHost(url, 'identity.xero.com')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    read: (async () => {
      reads += 1;
      // 1st read: the expired doc we start from. adoptWinner's read (2nd): the live winner.
      return reads === 1 ? { doc: expired, etag: 'etag-old' } : { doc: winner, etag: 'etag-new' };
    }) as never,
    replace: (async () => {
      wrote = true;
      return { ok: true, status: 200, body: {}, etag: null };
    }) as never,
    create: (async () => {
      wrote = true;
      return { ok: true, status: 201, body: {}, etag: null };
    }) as never,
  };
  const a = await getOrgAccess('otchealth', { deps: deps as never });
  assert.equal(a.accessToken, 'at-winner', 'must adopt the concurrent live winner');
  assert.equal(wrote, false, 'must NOT write a tombstone over a live winner');
});

test('SAFETY-CRITICAL (S2): every registered xero tool has its OWN in-handler ring gate — no gate can be dropped', () => {
  // The handlers each enforce EXEC_RING in-line (tools.ts). This structural lock pins that there is
  // exactly one isXeroAllowed(ctx.callerAgent) guard per registered tool, so a future copy-paste
  // (e.g. adding xero_payments) that drops the gate line fails CI instead of exposing MNPI.
  const src = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
  const tools = (src.match(/registerTool\(/g) || []).length;
  const gates = (src.match(/isXeroAllowed\(ctx\.callerAgent\)/g) || []).length;
  const refusals = (src.match(/return ringRefusal\(/g) || []).length;
  assert.equal(tools, 6, 'expected exactly 6 registered xero tools');
  assert.equal(gates, tools, 'every registered xero tool MUST call isXeroAllowed(ctx.callerAgent)');
  assert.equal(refusals, tools, 'every gate MUST return ringRefusal on a non-exec caller');
});

test('a persist FAILURE never returns an unpersisted chain (fail-closed on durability)', async () => {
  const expired = buildTokenDoc({
    org: 'otchealth',
    refreshToken: 'rt-shared',
    accessToken: 'at-expired',
    expiresInSeconds: 0,
    tenantId: 'tenant-1',
    tenantName: 'OTCHealth Inc.',
    bootstrapHash: bootstrapHash(process.env.XERO_RT_OTCHEALTH as string),
  });
  const deps = {
    fetchImpl: (async (url: string | URL) => {
      if (isHost(url, 'identity.xero.com')) return grantResponse(7);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    read: (async () => ({ doc: expired, etag: 'etag-1' })) as never,
    replace: (async () => ({ ok: false, status: 500, body: {}, etag: null })) as never,
    create: (async () => ({ ok: true, status: 201, body: {}, etag: null })) as never,
    upsert: (async () => ({ ok: true, status: 200, body: {}, etag: null })) as never,
  };
  await assert.rejects(
    () => getOrgAccess('otchealth', { deps: deps as never }),
    /NOT returning an unpersisted chain/,
    'returning a token whose rotated refresh token was not saved would orphan the chain',
  );
});

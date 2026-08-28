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
  isGrandfatheredForJournals,
  xeroGetAttachmentContent,
  MAX_ATTACHMENT_READ_BYTES,
  xeroRequest,
  extractXeroErrorDetail,
  XERO_ERROR_DETAIL_MAX_CHARS,
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

// -- isGrandfatheredForJournals: SAFETY-CRITICAL correctness fix (reviewer-caught, 2026-07-30) ----
// This used to compare createdDateUtc against XERO_JOURNALS_GRANDFATHER_CUTOFF and return
// true/false. That is unsafe: the April-29 grandfather rule applies specifically to Custom
// Connections (a client_credentials-grant app type); this gateway's token path uses the
// refresh_token/authorization_code grant (evidence of a STANDARD OAuth2 app, not a Custom
// Connection), and /connections exposes no field that identifies connection TYPE at all -- so
// createdDateUtc alone can never safely establish eligibility either way. A false `true` here is
// actively dangerous for an irreversible P0-1 freeze decision. Locked down to always-null so this
// can never silently regress back into a wrong answer.

test('SAFETY-CRITICAL: isGrandfatheredForJournals ALWAYS returns null, regardless of date -- it must never assert true/false again', () => {
  assert.equal(isGrandfatheredForJournals('2020-01-01T00:00:00Z'), null, 'well before the cutoff must still be null, not true');
  assert.equal(isGrandfatheredForJournals('2030-01-01T00:00:00Z'), null, 'well after the cutoff must still be null, not false');
  assert.equal(isGrandfatheredForJournals('2026-04-29T00:00:00Z'), null, 'exactly on the cutoff must still be null');
  assert.equal(isGrandfatheredForJournals(''), null);
  assert.equal(isGrandfatheredForJournals('not-a-date'), null);
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

test('SAFETY-CRITICAL (B3 residual): a success-path 412 against a same-family DEAD tombstone REVIVES with the fresh live chain (never discards a valid rotation)', async () => {
  const bHash = bootstrapHash(process.env.XERO_RT_OTCHEALTH as string);
  const expired = buildTokenDoc({
    org: 'otchealth', refreshToken: 'rt-0', accessToken: 'at-expired', expiresInSeconds: 0,
    tenantId: 'tenant-1', tenantName: 'OTCHealth Inc.', bootstrapHash: bHash,
  });
  const deadTomb = buildTokenDoc({
    org: 'otchealth', refreshToken: '', accessToken: '', expiresInSeconds: 0,
    tenantId: 'tenant-1', tenantName: 'OTCHealth Inc.', bootstrapHash: bHash,
  });
  deadTomb.status = 'dead';
  let reads = 0;
  let replaces = 0;
  const deps = {
    fetchImpl: (async (url: string | URL) => {
      if (isHost(url, 'identity.xero.com')) return grantResponse(1);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    read: (async () => {
      reads += 1;
      // read1: our starting expired doc. read2 (adoptWinner after 412) + read3 (revive read): the
      // racer's DEAD tombstone (holds no token material).
      return reads === 1 ? { doc: expired, etag: 'E0' } : { doc: deadTomb, etag: 'E-dead' };
    }) as never,
    replace: (async () => {
      replaces += 1;
      return replaces === 1 ? { ok: false, status: 412, body: {}, etag: null } : { ok: true, status: 200, body: {}, etag: 'E2' };
    }) as never,
    create: (async () => {
      throw new Error('create must not be called when a doc exists');
    }) as never,
  };
  const a = await getOrgAccess('otchealth', { deps: deps as never });
  assert.equal(a.accessToken, 'at-1', 'must revive the dead tombstone with the freshly-rotated live token, not throw');
  assert.equal(replaces, 2, 'one 412 on the live-write, then one successful revive replace of the tombstone');
});

test('SAFETY-CRITICAL (B3 tombstone path): a 412 on the dead-mark re-adopts a live winner rather than dead-marking over it', async () => {
  const bHash = bootstrapHash(process.env.XERO_RT_OTCHEALTH as string);
  const expired = buildTokenDoc({
    org: 'otchealth', refreshToken: 'rt-superseded', accessToken: 'at-x', expiresInSeconds: 0,
    tenantId: 'tenant-1', tenantName: 'n', bootstrapHash: bHash,
  });
  const winner = buildTokenDoc({
    org: 'otchealth', refreshToken: 'rt-w', accessToken: 'at-winner', expiresInSeconds: 1800,
    tenantId: 'tenant-1', tenantName: 'n', bootstrapHash: bHash,
  });
  let reads = 0;
  const deps = {
    fetchImpl: (async (url: string | URL) => {
      if (isHost(url, 'identity.xero.com')) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    read: (async () => {
      reads += 1;
      // read1: expired start. read2 (adopt-first, no winner yet): still expired. read3 (after the
      // tombstone-replace 412): the live winner a concurrent replica just persisted.
      return reads <= 2 ? { doc: expired, etag: 'E0' } : { doc: winner, etag: 'E-w' };
    }) as never,
    replace: (async () => ({ ok: false, status: 412, body: {}, etag: null })) as never, // the dead-mark replace races and 412s
    create: (async () => {
      throw new Error('create must not be called (doc exists)');
    }) as never,
  };
  const a = await getOrgAccess('otchealth', { deps: deps as never });
  assert.equal(a.accessToken, 'at-winner', 'the 412 on the tombstone write must re-adopt the live winner');
});

test('SAFETY-CRITICAL (S2): every registered xero tool has its OWN in-handler ring gate — no gate can be dropped', () => {
  // The handlers each enforce EXEC_RING in-line (tools.ts). This structural lock pins that there is
  // exactly one isXeroAllowed(ctx.callerAgent) guard per registerTool call-site, so a future copy-paste
  // (e.g. adding a xero_* tool) that drops the gate line fails CI instead of exposing MNPI. NOTE: the
  // count is registerTool CALL-SITES (literal text occurrences), not tool names — the shared
  // registerPagedAccountingRead helper contains exactly ONE registerTool( occurrence in its own
  // definition even though it is invoked multiple times (contacts/payments/credit_notes), so the
  // text-occurrence count is always <= the number of distinct tool names. Bumped 17->20 on 2026-07-30
  // (CFO P0-1/P0-2 mega-prompt fixes): +1 xero_connections, +1 xero_gl_assemble, +1 xero_bank_transfers
  // moved OUT of the shared paged-read helper into its own dedicated call-site (a gateway-side
  // pagination/date-filter shim — Xero's /BankTransfers endpoint ignores both server-side), which no
  // longer counts against the helper's shared occurrence. Every registerTool call-site MUST keep its
  // own gate; this count is the trip-wire that forces that discipline on the next addition too.
  // Bumped 20->21: +1 xero_attachment_content (the attachment-content READ path; its gate lives in
  // handleXeroAttachmentContent, the same standalone-exported-handler pattern the count already
  // relies on for xero_attachment_upload / handleXeroAttachmentUpload).
  const src = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
  const tools = (src.match(/registerTool\(/g) || []).length;
  const gates = (src.match(/isXeroAllowed\(ctx\.callerAgent\)/g) || []).length;
  const refusals = (src.match(/return ringRefusal\(/g) || []).length;
  assert.equal(tools, 21, 'expected exactly 21 registerTool call-sites (20 explicit + 1 shared helper)');
  assert.equal(gates, tools, 'every registerTool call-site MUST call isXeroAllowed(ctx.callerAgent)');
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

// ---------------------------------------------------------------------------------------------
// xeroGetAttachmentContent — the attachment CONTENT read path (the actual file bytes; this did not
// exist before this change). Every distinct failure mode gets its OWN test so a future edit cannot
// silently collapse two of them into the same outcome — the exact "a 403 read as not_found" failure
// class that cost eleven finance documents being written up as missing elsewhere in this repo today
// (see fetchBlobFromS3 in ../../legal/s3-blob-store.ts).
// ---------------------------------------------------------------------------------------------

function liveAttachmentDeps(fetchImpl: typeof fetch) {
  const doc = buildTokenDoc({
    org: 'otchealth',
    refreshToken: 'rt-live',
    accessToken: 'at-live',
    expiresInSeconds: 1800,
    tenantId: 'tenant-1',
    tenantName: 'OTCHealth Inc.',
    bootstrapHash: bootstrapHash(process.env.XERO_RT_OTCHEALTH as string),
  });
  return {
    fetchImpl,
    read: (async () => ({ doc, etag: 'etag-1' })) as never,
    replace: (async () => { throw new Error('replace should never be called — the seeded token is already live'); }) as never,
    create: (async () => { throw new Error('create should never be called — the seeded token is already live'); }) as never,
  };
}

// ---------------------------------------------------------------------------------------------
// extractXeroErrorDetail — FND-20260724-68f5 RESIDUAL (2026-08-28): a live CFO chart-of-accounts
// incident (5 varied POST /Accounts payloads) hit a Xero error body whose real cause sat past the
// OLD 2000-char raw-text-fallback boundary, cut off right before the actual text. The "clean
// shape" (Elements[].ValidationErrors[].Message) tier was ALREADY unbounded and not the culprit;
// the fallback used for anything that doesn't match that exact shape was. These tests pin all
// three tiers plus the new, wider (16KB) bound they share.
// ---------------------------------------------------------------------------------------------

test('extractXeroErrorDetail: a realistic, LONG Xero ValidationException body (chart-of-accounts create) survives intact -- the actual cause is not truncated even with a large echoed object ahead of it', () => {
  // Mirrors Xero's real documented shape: Elements echoes the submitted object's fields (which can
  // be sizeable for a multi-field Account/Invoice) BEFORE the nested ValidationErrors. The needle
  // sits well past the OLD 2000-char raw-text-fallback boundary to prove this is not a coincidence
  // of a short body.
  const needle = 'Account code "200" already exists as a BANK account (AccountID a1b2c3d4-...)';
  const echoedAccountObject = {
    AccountID: '00000000-0000-0000-0000-000000000000',
    Code: '200',
    Name: 'Business Checking Account, Reserve, and Escrow — Padding Field '.repeat(30),
    Type: 'BANK',
    TaxType: 'NONE',
    Description: 'A very long description field a real Xero echo can plausibly contain. '.repeat(20),
  };
  const xeroBody = {
    ErrorNumber: 10,
    Type: 'ValidationException',
    Message: 'A validation exception occurred',
    Elements: [{ ...echoedAccountObject, ValidationErrors: [{ Message: needle }] }],
  };
  const rawText = JSON.stringify(xeroBody);
  assert.ok(rawText.length > 2000, 'the fixture must actually exceed the OLD cap to prove anything');

  const detail = extractXeroErrorDetail(rawText);
  assert.match(detail, /A validation exception occurred/);
  assert.ok(detail.includes(needle), `the real cause must survive intact; got: ${detail}`);
  // Regression proof: slicing the RAW text at the old 2000-char bound would have missed the needle
  // entirely -- so this is testing the actual defect, not a scenario that always happened to pass.
  assert.equal(rawText.slice(0, 2000).includes(needle), false, 'fixture sanity: the needle must sit past the OLD cap');
});

test('extractXeroErrorDetail: multiple Elements/ValidationErrors are all preserved, unbounded by the old 2000-char cap', () => {
  const elements = Array.from({ length: 20 }, (_, i) => ({
    Code: String(100 + i),
    Name: 'Padding '.repeat(20),
    ValidationErrors: [{ Message: `element-${i}-cause` }],
  }));
  const rawText = JSON.stringify({ Type: 'ValidationException', Message: 'A validation exception occurred', Elements: elements });
  assert.ok(rawText.length > 2000);
  const detail = extractXeroErrorDetail(rawText);
  for (let i = 0; i < 20; i++) assert.ok(detail.includes(`element-${i}-cause`), `element-${i}-cause missing from: ${detail}`);
});

test('extractXeroErrorDetail: Elements present but no ValidationErrors[].Message anywhere -- preserves the real Elements structure VERBATIM instead of falling to the raw-text slice', () => {
  const rawText = JSON.stringify({
    Type: 'ValidationException',
    Elements: [{ Code: '200', SomeUnrecognizedField: 'the real cause lives here, not under Message' }],
  });
  const detail = extractXeroErrorDetail(rawText);
  // Verbatim means it round-trips back to the exact structure Xero sent, not a lossy string.
  const roundTripped = JSON.parse(detail);
  assert.deepEqual(roundTripped, [{ Code: '200', SomeUnrecognizedField: 'the real cause lives here, not under Message' }]);
});

test('extractXeroErrorDetail: a genuinely non-JSON body now gets the WIDER 16KB raw-text fallback, not the old 2000-char one', () => {
  const needle = 'THE_REAL_CAUSE_PAST_THE_OLD_2000_CHAR_CAP';
  const rawText = `Upstream gateway error (not Xero-shaped JSON). ${'X'.repeat(2100)} ${needle}`;
  assert.equal(rawText.slice(0, 2000).includes(needle), false, 'fixture sanity: the needle must sit past the OLD cap');
  const detail = extractXeroErrorDetail(rawText);
  assert.ok(detail.includes(needle), `the raw-text fallback must reach the wider bound; got tail: ${detail.slice(-80)}`);
});

test('extractXeroErrorDetail: still genuinely bounded -- a pathological huge body never produces an unbounded string', () => {
  const rawText = 'Z'.repeat(200000);
  const detail = extractXeroErrorDetail(rawText);
  assert.equal(detail.length, XERO_ERROR_DETAIL_MAX_CHARS);
});

test('extractXeroErrorDetail: XERO_ERROR_DETAIL_MAX_CHARS is the new, wider bound (16KB), not the old 2000', () => {
  assert.equal(XERO_ERROR_DETAIL_MAX_CHARS, 16 * 1024);
});

test('xeroRequest: END TO END — a real Xero ValidationException on POST /Accounts (the live CFO chart-of-accounts incident) reaches the thrown error intact, not cut off before the actual cause', async () => {
  // This is the full client.ts boundary a caller (the xero_request tool handler) actually sees:
  // xeroGet/xeroRequest are the ONLY two places that construct the thrown Error from a Xero 4xx/5xx
  // body, and registry.ts's generic tool-error handler relays a thrown Error's `.message` verbatim
  // into both the MCP tool result's structuredContent.error.message and its content[0].text (no
  // further truncation there) -- so what xeroRequest throws here IS what the calling agent receives.
  const liveDoc = buildTokenDoc({
    org: 'otchealth',
    refreshToken: 'rt-live',
    accessToken: 'at-live',
    expiresInSeconds: 1800,
    tenantId: 'tenant-1',
    tenantName: 'OTCHealth Inc.',
    bootstrapHash: bootstrapHash(process.env.XERO_RT_OTCHEALTH as string),
  });
  const needle = 'Account code "200" is already assigned to another BANK account';
  const xeroBody = {
    ErrorNumber: 10,
    Type: 'ValidationException',
    Message: 'A validation exception occurred',
    Elements: [
      {
        AccountID: '00000000-0000-0000-0000-000000000000',
        Code: '200',
        Name: 'Padding-heavy echoed account field. '.repeat(60),
        Type: 'BANK',
        ValidationErrors: [{ Message: needle }],
      },
    ],
  };
  const bodyText = JSON.stringify(xeroBody);
  assert.ok(bodyText.length > 2000, 'fixture sanity: must actually exceed the old cap to prove anything');

  const deps = {
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/Accounts') && init?.method === 'POST') {
        return new Response(bodyText, { status: 400 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    read: (async () => ({ doc: liveDoc, etag: 'etag-1' })) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };

  await assert.rejects(
    () => xeroRequest('otchealth', 'POST', '/Accounts', { Accounts: [{ Code: '200', Name: 'Test Bank Account', Type: 'BANK' }] }, {}, { deps: deps as never }),
    (err: Error) => {
      assert.ok(err.message.includes(needle), `the real Xero ValidationException detail must survive; got: ${err.message}`);
      assert.match(err.message, /HTTP 400/);
      return true;
    },
  );
});

test('xeroGetAttachmentContent: BINARY INTEGRITY — bytes round-trip EXACTLY, including a NUL byte and invalid-UTF-8 sequences a .text()-based path would corrupt', async () => {
  // 0x00 never appears in valid UTF-8 text; 0xff/0xfe are invalid UTF-8 continuation bytes that get
  // replaced with U+FFFD by any text-decoding path. If this function ever regressed to routing
  // through xeroGet's .text()-then-JSON.parse (see xeroGetAttachmentContent's header comment in
  // client.ts), this exact buffer would come back different from what was sent.
  const original = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x01, 0x02, 0x03, 0x7f, 0x80]);
  let requestedUrl: string | null = null;
  let requestedAccept: string | null = null;
  const deps = liveAttachmentDeps((async (url: string | URL, init?: RequestInit) => {
    requestedUrl = String(url);
    requestedAccept = (init?.headers as Record<string, string> | undefined)?.Accept ?? null;
    return new Response(original, {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(original.length) },
    });
  }) as typeof fetch);

  const outcome = await xeroGetAttachmentContent(
    'otchealth',
    'ManualJournals',
    'journal-1',
    { by: 'fileName', value: 'statement.pdf' },
    { deps: deps as never },
  );

  assert.equal(outcome.kind, 'ok');
  if (outcome.kind !== 'ok') return;
  assert.deepEqual(outcome.bytes, original, 'every byte must round-trip identically — no UTF-8 re-encoding');
  assert.equal(outcome.byteLength, original.length);
  assert.equal(outcome.contentType, 'application/pdf');
  // Never asks for JSON — that would get Xero's metadata response instead of the file (see the
  // 'unexpected_content_type' outcome + xeroGetAttachmentContent's header comment).
  assert.equal(requestedAccept, '*/*');
  assert.ok(requestedUrl?.endsWith('/ManualJournals/journal-1/Attachments/statement.pdf'));
});

test('xeroGetAttachmentContent: ENCODING — a fileName with spaces and parentheses is encoded EXACTLY ONCE, never double-encoded (%2520)', async () => {
  let requestedUrl: string | null = null;
  const deps = liveAttachmentDeps((async (url: string | URL) => {
    requestedUrl = String(url);
    return new Response(Buffer.from('ok'), { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }) as typeof fetch);

  await xeroGetAttachmentContent(
    'otchealth',
    'Invoices',
    'inv-1',
    { by: 'fileName', value: 'Signed Order (002).pdf' },
    { deps: deps as never },
  );

  // encodeURIComponent leaves ( ) unescaped and turns the space into %20 — exactly once.
  assert.ok(requestedUrl?.includes('/Attachments/Signed%20Order%20(002).pdf'), `unexpected URL: ${requestedUrl}`);
  assert.equal(requestedUrl?.includes('%2520'), false, 'double-encoded: a real Xero server answers this with a silent 403');
});

test('xeroGetAttachmentContent: an attachmentId (a GUID) needs no encoding and passes through unchanged — the SAFER identifier', async () => {
  let requestedUrl: string | null = null;
  const deps = liveAttachmentDeps((async (url: string | URL) => {
    requestedUrl = String(url);
    return new Response(Buffer.from('ok'), { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }) as typeof fetch);

  await xeroGetAttachmentContent(
    'otchealth',
    'Invoices',
    'inv-1',
    { by: 'attachmentId', value: 'b3d5e801-7d26-41cd-8128-39e88e96f713' },
    { deps: deps as never },
  );
  assert.ok(requestedUrl?.endsWith('/Invoices/inv-1/Attachments/b3d5e801-7d26-41cd-8128-39e88e96f713'));
});

test('xeroGetAttachmentContent: 404 -> not_found, and it is a DISTINCT kind from 403', async () => {
  const deps = liveAttachmentDeps((async () => new Response(JSON.stringify({ Message: 'Attachment not found' }), { status: 404 })) as typeof fetch);
  const outcome = await xeroGetAttachmentContent('otchealth', 'Invoices', 'inv-1', { by: 'attachmentId', value: 'missing' }, { deps: deps as never });
  assert.equal(outcome.kind, 'not_found');
  if (outcome.kind === 'not_found') {
    assert.equal(outcome.status, 404);
    assert.match(outcome.detail, /not found/i);
  }
});

test('xeroGetAttachmentContent: 403 -> forbidden, NEVER reported as not_found (the exact failure class this tool exists to prevent)', async () => {
  const deps = liveAttachmentDeps((async () => new Response(JSON.stringify({ Message: 'Forbidden' }), { status: 403 })) as typeof fetch);
  const outcome = await xeroGetAttachmentContent('otchealth', 'Invoices', 'inv-1', { by: 'attachmentId', value: 'denied' }, { deps: deps as never });
  assert.equal(outcome.kind, 'forbidden');
  assert.notEqual(outcome.kind, 'not_found');
  if (outcome.kind === 'forbidden') assert.equal(outcome.status, 403);
});

test('xeroGetAttachmentContent: a 401 that persists after one forced-refresh retry is auth_failed, distinct from forbidden/not_found', async () => {
  // Realistic shape: the TOKEN REFRESH itself succeeds (identity.xero.com is healthy — that failure
  // mode belongs to getOrgAccess/refreshGrant and already propagates as a generic thrown error,
  // exactly like every other client.ts caller), but the attachment-content endpoint keeps refusing
  // with 401 even after the retry picks up a fresh access token. Two counters distinguish "did we
  // actually retry" (contentAttempts) from "did we actually refresh" (grantAttempts).
  let contentAttempts = 0;
  let grantAttempts = 0;
  const liveDoc = buildTokenDoc({
    org: 'otchealth',
    refreshToken: 'rt-live',
    accessToken: 'at-live',
    expiresInSeconds: 1800,
    tenantId: 'tenant-1',
    tenantName: 'OTCHealth Inc.',
    bootstrapHash: bootstrapHash(process.env.XERO_RT_OTCHEALTH as string),
  });
  // Unlike liveAttachmentDeps, forceRefresh:true DOES persist here (that's the whole point of this
  // test) — so replace must actually succeed, not throw.
  const deps = {
    fetchImpl: (async (url: string | URL) => {
      if (isHost(url, 'identity.xero.com')) {
        grantAttempts += 1;
        return grantResponse(grantAttempts);
      }
      contentAttempts += 1;
      return new Response(JSON.stringify({ Message: 'Unauthorized' }), { status: 401 });
    }) as typeof fetch,
    read: (async () => ({ doc: liveDoc, etag: 'etag-1' })) as never,
    replace: (async () => ({ ok: true, status: 200, body: {}, etag: 'etag-2' })) as never,
    create: (async () => { throw new Error('create should never be called — a doc already exists'); }) as never,
  };
  const outcome = await xeroGetAttachmentContent('otchealth', 'Invoices', 'inv-1', { by: 'attachmentId', value: 'x' }, { deps: deps as never });
  assert.equal(outcome.kind, 'auth_failed');
  assert.equal(contentAttempts, 2, 'exactly one forced-refresh retry against the content endpoint, matching xeroGet/xeroRequest');
  assert.equal(grantAttempts, 1, 'the retry actually forced a fresh token refresh, not a second no-op attempt with the same stale token');
});

test('xeroGetAttachmentContent: TOO LARGE via a declared Content-Length — refuses BEFORE downloading, never truncates', async () => {
  let bodyConsumed = false;
  const big = MAX_ATTACHMENT_READ_BYTES + 1;
  const deps = liveAttachmentDeps((async () => {
    const r = new Response(Buffer.alloc(10), {
      status: 200,
      headers: { 'Content-Length': String(big), 'Content-Type': 'application/pdf' },
    });
    const realArrayBuffer = r.arrayBuffer.bind(r);
    r.arrayBuffer = async () => {
      bodyConsumed = true;
      return realArrayBuffer();
    };
    return r;
  }) as typeof fetch);
  const outcome = await xeroGetAttachmentContent('otchealth', 'Invoices', 'inv-1', { by: 'attachmentId', value: 'huge' }, { deps: deps as never });
  assert.equal(outcome.kind, 'too_large');
  if (outcome.kind === 'too_large') {
    assert.equal(outcome.contentLengthHeader, String(big));
    assert.equal(outcome.actualBytes, null, 'refused from the header alone — the body was never read');
    assert.equal(outcome.cap, MAX_ATTACHMENT_READ_BYTES);
    // Declared-header refusal knows the EXACT size Xero itself sent — never a partial/streamed
    // observation — so truncatedEarly must be false here even though actualBytes is null.
    assert.equal(outcome.truncatedEarly, false, 'PASS 1 (header-declared) is an exact refusal, not a lower bound');
  }
  assert.equal(bodyConsumed, false, 'must refuse BEFORE calling arrayBuffer() on an oversized declared length');
});

test('xeroGetAttachmentContent: TOO LARGE with no/understated Content-Length — caught DURING a streaming read as defense in depth, reports the size observed so far, never returns a truncated prefix', async () => {
  // UPDATED CONTRACT (2026-08-18 fix, replaces the old assertion that this path called
  // r.arrayBuffer()): the whole point of the fix is that a missing/understated Content-Length is now
  // caught by STREAMING, not by first buffering the whole body via arrayBuffer() and measuring it
  // afterward. A real (undici) Response object hands its already-in-memory body to a stream reader as
  // ONE single chunk (verified directly against this repo's Node/undici version), so this particular
  // fixture happens to still observe the file's exact real length — that is a property of THIS
  // fixture (a single-chunk body), not a guarantee the implementation provides; see the dedicated
  // multi-chunk test below for the actual "must not buffer it all" proof via a real multi-chunk
  // stream, where the true total is provably NOT what gets observed.
  const big = Buffer.alloc(MAX_ATTACHMENT_READ_BYTES + 500, 0x41);
  const deps = liveAttachmentDeps((async () => new Response(big, { status: 200, headers: { 'Content-Type': 'application/pdf' } })) as typeof fetch);
  const outcome = await xeroGetAttachmentContent('otchealth', 'Invoices', 'inv-1', { by: 'attachmentId', value: 'huge2' }, { deps: deps as never });
  assert.equal(outcome.kind, 'too_large');
  if (outcome.kind === 'too_large') {
    assert.equal(outcome.actualBytes, big.length, 'the size actually observed before cancelling — for this single-chunk fixture that equals the real size');
    assert.equal(outcome.cap, MAX_ATTACHMENT_READ_BYTES);
    assert.equal(outcome.truncatedEarly, true, 'the read was cancelled via the streaming path, not drained by a full arrayBuffer() read — actualBytes is a lower bound by contract, even though it is exact for this fixture');
  }
});

test('xeroGetAttachmentContent: a chunked / no-Content-Length oversized body is refused WITHOUT ever buffering it all — the actual FIX 1 proof, via a mock multi-chunk stream that counts pulls', async () => {
  // This is the test the old implementation could not pass: r.arrayBuffer() on a real chunked
  // response would pull EVERY chunk before the size was ever checked. Here the mock stream yields 4
  // chunks of 400 KiB each (1600 KiB total); the 1 MiB (1024 KiB) cap is exceeded partway through the
  // 3rd chunk (400*3 = 1200 KiB > 1024 KiB), so the 4th chunk must NEVER be pulled — proven by
  // counting reader.read() data-chunk calls, not by inspecting byte totals alone.
  const chunkSize = 400 * 1024;
  const chunks = [
    Buffer.alloc(chunkSize, 0x41),
    Buffer.alloc(chunkSize, 0x42),
    Buffer.alloc(chunkSize, 0x43),
    Buffer.alloc(chunkSize, 0x44),
  ];
  let pulls = 0;
  let cancelled = false;
  const iterator = chunks[Symbol.iterator]();
  const reader = {
    read: async () => {
      const next = iterator.next();
      if (next.done) return { done: true as const, value: undefined };
      pulls += 1;
      return { done: false as const, value: next.value };
    },
    cancel: async () => {
      cancelled = true;
    },
  };
  const fakeResponse = {
    ok: true,
    status: 200,
    headers: {
      // No content-length header at all -- PASS 1 must NOT fire, forcing the streaming PASS 2 path.
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/pdf' : null),
    },
    body: { getReader: () => reader },
    arrayBuffer: async () => {
      throw new Error('arrayBuffer() must NEVER be called when a stream reader is available — this is exactly the unbounded-buffering defect FIX 1 closes');
    },
    text: async () => {
      throw new Error('text() must never be called for a 2xx binary body');
    },
  };
  const deps = liveAttachmentDeps((async () => fakeResponse as unknown as Response) as typeof fetch);
  const outcome = await xeroGetAttachmentContent('otchealth', 'Invoices', 'inv-1', { by: 'attachmentId', value: 'chunked-huge' }, { deps: deps as never });
  assert.equal(outcome.kind, 'too_large');
  if (outcome.kind === 'too_large') {
    assert.equal(outcome.actualBytes, chunkSize * 3, 'observed exactly the 3 pulled chunks — NOT the real 4-chunk total (1600 KiB), proving it was not fully buffered');
    assert.equal(outcome.cap, MAX_ATTACHMENT_READ_BYTES);
    assert.equal(outcome.truncatedEarly, true, 'actualBytes is a lower bound, not the real total');
  }
  assert.equal(pulls, 3, 'must stop pulling the MOMENT the running total exceeds the cap — the 4th chunk is never read');
  assert.equal(cancelled, true, 'the reader must be explicitly cancelled, not merely abandoned');
});

test('xeroGetAttachmentContent: an optional mimeType hint rides ahead of the wildcard in Accept; omitting it sends the unchanged plain wildcard', async () => {
  let acceptSeen: string | null = null;
  const deps = liveAttachmentDeps((async (url: string | URL, init?: RequestInit) => {
    acceptSeen = (init?.headers as Record<string, string> | undefined)?.Accept ?? null;
    return new Response(Buffer.from('ok'), { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }) as typeof fetch);

  await xeroGetAttachmentContent(
    'otchealth',
    'Invoices',
    'inv-1',
    { by: 'attachmentId', value: 'x' },
    { deps: deps as never, mimeTypeHint: 'application/pdf' },
  );
  assert.equal(acceptSeen, 'application/pdf, */*', 'the hint rides ahead of the wildcard, matching xero-node SDK precedent');

  await xeroGetAttachmentContent('otchealth', 'Invoices', 'inv-1', { by: 'attachmentId', value: 'y' }, { deps: deps as never });
  assert.equal(acceptSeen, '*/*', 'no hint supplied -> the exact same plain wildcard this endpoint has always sent, unchanged');
});

test('xeroGetAttachmentContent: a 2xx application/json body is an unexpected_content_type anomaly, never silently handed back labeled as "the file"', async () => {
  const jsonBody = JSON.stringify({ AttachmentID: 'att-1', FileName: 'statement.pdf', ContentLength: 12345 });
  const deps = liveAttachmentDeps((async () => new Response(jsonBody, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } })) as typeof fetch);
  const outcome = await xeroGetAttachmentContent('otchealth', 'Invoices', 'inv-1', { by: 'attachmentId', value: 'weird' }, { deps: deps as never });
  assert.equal(outcome.kind, 'unexpected_content_type');
  if (outcome.kind === 'unexpected_content_type') {
    assert.match(outcome.contentType, /application\/json/);
    assert.match(outcome.bodyPreview, /AttachmentID/);
  }
});

test('xeroGetAttachmentContent: any other non-2xx status is xero_error, distinct from every named case above', async () => {
  const deps = liveAttachmentDeps((async () => new Response('Internal Server Error', { status: 500 })) as typeof fetch);
  const outcome = await xeroGetAttachmentContent('otchealth', 'Invoices', 'inv-1', { by: 'attachmentId', value: 'x' }, { deps: deps as never });
  assert.equal(outcome.kind, 'xero_error');
  if (outcome.kind === 'xero_error') assert.equal(outcome.status, 500);
});

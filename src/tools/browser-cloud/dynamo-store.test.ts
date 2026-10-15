import assert from "node:assert/strict";
import test from "node:test";
import { DynamoCloudBrowserSessionStore } from "./dynamo-store.js";
import type { CloudBrowserProfile, CloudBrowserSession } from "./contract.js";
import { CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS } from "./service.js";

const ownedSession: CloudBrowserSession = {
  sessionId: "session-1",
  owner: "developer",
  profileId: "developer-trial",
  allowedHosts: ["example.com"],
  expiresAt: 100_000,
  actionsUsed: 2,
  providerSessionId: "provider-1",
  automationEndpoint: "wss://example.com/browser",
  ownedTargetIds: ["target-1", "target-2"],
  selectedTargetId: "target-2",
  effectUnknown: true,
};

test('fenced session endpoint updates persist the new provider endpoint without replacing or removing its session lock', async t => {
  const prior = { ...process.env }; t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access'; process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  let item: Record<string, any> = {}; let update: Record<string, any> = {};
  const store = new DynamoCloudBrowserSessionStore('synthetic-state', 'us-east-1', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.Item) item = { ...request.Item, lockOwner: { S: 'viewer-lock' }, lockUntil: { N: '200000' } };
    if (request.UpdateExpression) { update = request; if (request.ExpressionAttributeValues[':automationEndpoint']) item.automationEndpoint = request.ExpressionAttributeValues[':automationEndpoint']; }
    return new Response(JSON.stringify(request.ConsistentRead ? { Item: item } : {}));
  });
  await store.saveSession(ownedSession);
  const endpoint = 'wss://provider.example/updated-automation';
  await store.saveSessionUnderLock({ ...ownedSession, automationEndpoint: endpoint }, 'viewer-lock');
  assert.equal((await store.loadSession(ownedSession.sessionId))?.automationEndpoint, endpoint);
  assert.equal(update.ConditionExpression, 'lockOwner = :owner');
  assert.doesNotMatch(update.UpdateExpression, /REMOVE|lockOwner\s*=|lockUntil\s*=/);
  assert.deepEqual(item.lockOwner, { S: 'viewer-lock' }); assert.deepEqual(item.lockUntil, { N: '200000' });
});

test('fenced endpoint writes reject malformed, credential-bearing or signed URLs before DynamoDB', async t => {
  const prior = { ...process.env }; t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access'; process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  let requests = 0;
  const store = new DynamoCloudBrowserSessionStore('synthetic-state', 'us-east-1', async () => { requests++; return new Response('{}'); });
  for (const endpoint of ['not-a-url', 'https://provider.example/stream', 'wss://user:private@provider.example/stream', 'wss://provider.example/stream?signature=private', 'wss://provider.example/stream#private']) {
    await assert.rejects(store.saveSessionUnderLock({ ...ownedSession, automationEndpoint: endpoint }, 'viewer-lock'), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'session_state_invalid');
  }
  assert.equal(requests, 0);
});

test('persistent profile intents support every eligible company lane and remain create-only', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const requests: Record<string, any>[] = [];
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('{}');
  });
  for (const owner of CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS) {
    const profile: CloudBrowserProfile = {
      profileId: `web-${owner}-linkedin-test`, owner, ownerSubjectHash: 'a'.repeat(64),
      allowedHosts: ['www.linkedin.com'], persistent: true, maxSessionSeconds: 3600,
    };
    assert.equal(await store.createProfileIntent(profile), true);
    const request = requests.at(-1)!;
    assert.equal(request.ConditionExpression, 'attribute_not_exists(pk)');
    assert.deepEqual(request.Item.pk, { S: `PROFILE#${profile.profileId}` });
    assert.deepEqual(request.Item.owner, { S: owner });
    assert.deepEqual(request.Item.ownerSubjectHash, { S: profile.ownerSubjectHash });
    assert.equal(request.Item.providerProfileId, undefined);
  }
  assert.equal(requests.length, CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS.length);
});

test('persistent profile intents reject foreign lanes, absent principals and provider-backed profiles before AWS', async () => {
  let requests = 0;
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async () => {
    requests += 1;
    return new Response('{}');
  });
  const profile: CloudBrowserProfile = {
    profileId: 'web-cto-linkedin-test', owner: 'cto', ownerSubjectHash: 'a'.repeat(64),
    allowedHosts: ['www.linkedin.com'], persistent: true,
  };
  for (const invalid of [
    { ...profile, owner: 'clo-personal' },
    { ...profile, owner: 'external' },
    { ...profile, ownerSubjectHash: undefined },
    { ...profile, ownerSubjectHash: 'not-a-hash' },
    { ...profile, providerProfileId: 'existing-provider-profile' },
  ]) await assert.rejects(store.createProfileIntent(invalid), { code: 'profile_intent_invalid' });
  assert.equal(requests, 0);
});

test('duplicate profile intent returns a conflict without overwriting the enrolled profile', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.ConditionExpression, 'attribute_not_exists(pk)');
    return new Response(JSON.stringify({ __type: 'com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException' }), { status: 400 });
  });
  assert.equal(await store.createProfileIntent({
    profileId: 'web-wefunder-campaign-director-linkedin-test', owner: 'wefunder-campaign-director',
    ownerSubjectHash: 'a'.repeat(64), allowedHosts: ['www.linkedin.com'], persistent: true,
  }), false);
});

test('login lease verification permits an unleased profile or matching owner and denies active ordinary/foreign starts', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const profileId = 'web-cto-linkedin-test';
  const pk = `WEBSITE_LOGIN_LEASE#${profileId}`;
  const leaseOwner = 'a73bb282-61d0-4a0f-8b22-1d2332efb778';
  let item: Record<string, any> | undefined;
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.ConsistentRead, true);
    assert.deepEqual(request.Key, { pk: { S: pk } });
    return new Response(JSON.stringify(item ? { Item: item } : {}));
  }, () => 100_000);
  assert.equal(await store.verifyLoginLease(profileId), true);
  item = { pk: { S: pk }, lockOwner: { S: leaseOwner }, lockUntil: { N: '100001' } };
  assert.equal(await store.verifyLoginLease(profileId), false);
  assert.equal(await store.verifyLoginLease(profileId, 'foreign-owner'), false);
  assert.equal(await store.verifyLoginLease(profileId, leaseOwner), true);
  item.lockUntil = { N: '100000' };
  assert.equal(await store.verifyLoginLease(profileId), false, 'equal-time lock remains active');
  item.lockUntil = { N: '99999' };
  assert.equal(await store.verifyLoginLease(profileId), true);
  assert.equal(await store.verifyLoginLease(profileId, 'foreign-owner'), true);
  item = undefined;
  assert.equal(await store.verifyLoginLease(profileId), true, 'conditional lease deletion permits profile reopening before table TTL');
});

test('malformed login lease records and invalid lookup identifiers fail closed', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const profileId = 'web-cto-linkedin-test';
  const pk = `WEBSITE_LOGIN_LEASE#${profileId}`;
  const lease = { pk: { S: pk }, lockOwner: { S: 'trusted-owner' }, lockUntil: { N: '100001' } };
  let item: unknown = lease;
  let requests = 0;
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async () => {
    requests += 1;
    return new Response(JSON.stringify({ Item: item }));
  }, () => 100_000);
  for (const invalid of [
    null, [], {}, { pk: { S: pk } }, { pk: { S: pk }, expiresAtEpoch: { N: 'invalid' } },
    { ...lease, pk: { S: 'WEBSITE_LOGIN_LEASE#foreign' } },
    { ...lease, lockOwner: undefined }, { ...lease, lockOwner: { S: '' } },
    { ...lease, lockUntil: undefined }, { ...lease, lockUntil: { N: 'not-a-time' } },
    { ...lease, lockUntil: { N: '-1' } }, { ...lease, lockUntil: { N: '100001.5' } },
    { ...lease, lockUntil: { N: '9007199254740992' } },
  ]) {
    item = invalid;
    assert.equal(await store.verifyLoginLease(profileId, 'trusted-owner'), false);
  }
  const completedRequests = requests;
  assert.equal(await store.verifyLoginLease('foreign/profile'), false);
  assert.equal(await store.verifyLoginLease(profileId, ''), false);
  assert.equal(requests, completedRequests);
});

test("tab ownership, selection and uncertain effects survive durable round-trip and fenced updates", async (t) => {
  const prior = { ...process.env };
  t.after(() => {
    process.env = prior;
  });
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  const requests: Record<string, any>[] = [];
  let savedItem: unknown;
  const store = new DynamoCloudBrowserSessionStore("synthetic-browser-state", "us-east-1", async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    if (request.Item) savedItem = request.Item;
    return new Response(JSON.stringify(request.ConsistentRead ? { Item: savedItem } : {}));
  });
  await store.saveSession(ownedSession);
  const loaded = await store.loadSession(ownedSession.sessionId);
  assert.deepEqual(loaded?.ownedTargetIds, ["target-1", "target-2"]);
  assert.equal(loaded?.selectedTargetId, "target-2");
  assert.equal(loaded?.effectUnknown, true);
  await store.saveSessionUnderLock(
    {
      ...ownedSession,
      selectedTargetId: null,
      ownedTargetIds: [],
      effectUnknown: false,
    },
    "writer-1",
  );
  const update = requests.at(-1)!;
  assert.equal(update.ConditionExpression, "lockOwner = :owner");
  assert.match(update.UpdateExpression, /ownedTargetIds = :targets/);
  assert.match(update.UpdateExpression, /selectedTargetId = :selected/);
  assert.match(update.UpdateExpression, /effectUnknown = :uncertain/);
  assert.deepEqual(update.ExpressionAttributeValues[":targets"], { L: [] });
  assert.deepEqual(update.ExpressionAttributeValues[":selected"], {
    NULL: true,
  });
  assert.deepEqual(update.ExpressionAttributeValues[":uncertain"], {
    BOOL: false,
  });
});

test("malformed or contradictory durable tab state is rejected without enrolling unknown targets", async (t) => {
  const prior = { ...process.env };
  t.after(() => {
    process.env = prior;
  });
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  let item: Record<string, unknown> = {};
  const store = new DynamoCloudBrowserSessionStore("synthetic-browser-state", "us-east-1", async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.Item) {
      item = request.Item;
      return new Response("{}");
    }
    return new Response(JSON.stringify({ Item: item }));
  });
  await store.saveSession(ownedSession);
  item.selectedTargetId = { S: "foreign-target" };
  assert.equal(await store.loadSession(ownedSession.sessionId), null);
  item.selectedTargetId = { S: "target-2" };
  item.ownedTargetIds = { L: [{ S: "target-2" }, { N: "7" }] };
  assert.equal(await store.loadSession(ownedSession.sessionId), null);
});

test("profile persistence aliases the DynamoDB reserved owner attribute in its conditional write", async (t) => {
  const prior = { ...process.env };
  t.after(() => {
    process.env = prior;
  });
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";

  let body = "";
  const store = new DynamoCloudBrowserSessionStore("synthetic-browser-state", "us-east-1", async (_url, init) => {
    body = String(init?.body);
    return new Response("{}", { status: 200 });
  }, () => 42_000);

  await store.saveProfile({
    profileId: "cfo-public-trial",
    owner: "cfo",
    allowedHosts: ["example.com"],
    persistent: false,
  });

  const request = JSON.parse(body) as {
    ConditionExpression?: unknown;
    ExpressionAttributeNames?: unknown;
    ExpressionAttributeValues?: unknown;
  };
  assert.equal(request.ConditionExpression, "attribute_not_exists(pk) OR (#owner = :owner AND (attribute_not_exists(lockUntil) OR lockUntil < :now))");
  assert.deepEqual(request.ExpressionAttributeNames, { "#owner": "owner" });
  assert.deepEqual(request.ExpressionAttributeValues, {
    ":owner": { S: "cfo" },
    ":now": { N: "42000" },
  });
});

test('expired-session cleanup claim and delete are owner, expiry, and lease fenced', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const requests: Record<string, any>[] = [];
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('{}');
  });

  assert.equal(await store.claimExpiredSessionCleanup('session-1', 'developer', 100_000, 'recovery-token', 130_000), true);
  const claim = requests.at(-1)!;
  assert.equal(claim.UpdateExpression, 'SET lockOwner = :lockOwner, lockUntil = :until');
  assert.match(claim.ConditionExpression, /#owner = :owner/);
  assert.match(claim.ConditionExpression, /expiresAt <= :now/);
  assert.match(claim.ConditionExpression, /lockUntil < :now/);
  assert.deepEqual(claim.Key, { pk: { S: 'SESSION#session-1' } });

  assert.equal(await store.deleteExpiredSessionUnderLock('session-1', 'developer', 'recovery-token', 100_000), true);
  const deletion = requests.at(-1)!;
  assert.equal(deletion.ConditionExpression, '#owner = :owner AND lockOwner = :lockOwner AND expiresAt <= :now');
  assert.deepEqual(deletion.Key, { pk: { S: 'SESSION#session-1' } });
});

test("public profile and provider browser binding survive durable round-trip", async (t) => {
  const prior = { ...process.env };
  t.after(() => {
    process.env = prior;
  });
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  let item: Record<string, any> = {};
  const store = new DynamoCloudBrowserSessionStore("synthetic-browser-state", "us-east-1", async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.Item) {
      item = request.Item;
      return new Response("{}");
    }
    return new Response(JSON.stringify(request.ConsistentRead ? { Item: item } : {}));
  });
  const profile: CloudBrowserProfile = {
    profileId: "cto-public-web",
    owner: "cto",
    allowedHosts: [],
    persistent: false,
    mode: "public_web",
    customBrowserIdentifier: "browser-public",
    networkPolicyVersion: "egress-v3",
    privateHostPolicy: "proxy-acl-v2",
    proxyConfiguration: {
      proxies: [{ externalProxy: { server: "proxy.example.net", port: 8080 } }],
    },
    actionBudget: 500,
    maxSessionSeconds: 28_800,
    maxActionSeconds: 120,
  };
  await store.saveProfile(profile);
  const loaded = await store.loadProfile(profile.profileId);
  assert.deepEqual(loaded, profile);
  const session = {
    ...ownedSession,
    providerBrowserId: "browser-public",
    mode: "public_web" as const,
    actionBudget: 250,
  };
  await store.saveSession(session);
  const restored = await store.loadSession(session.sessionId);
  assert.equal(restored?.providerBrowserId, "browser-public");
  assert.equal(restored?.actionBudget, 250);
  assert.equal(restored?.mode, "public_web");
});

test('authenticated subject binding survives profile/session persistence and rejects malformed durable values', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access'; process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  let item: Record<string, any> = {};
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.Item) { item = request.Item; return new Response('{}'); }
    return new Response(JSON.stringify({ Item: item }));
  });
  const subjectHash = 'A'.repeat(64);
  const profile: CloudBrowserProfile = { profileId: 'coo-bound', owner: 'coo', allowedHosts: ['example.com'], persistent: true, maxSessionSeconds: 28_800, ownerSubjectHash: subjectHash };
  await store.saveProfile(profile);
  assert.deepEqual(item.ownerSubjectHash, { S: 'a'.repeat(64) });
  assert.deepEqual(await store.loadProfile(profile.profileId), { ...profile, ownerSubjectHash: 'a'.repeat(64) });

  const session = { ...ownedSession, ownerSubjectHash: subjectHash };
  await store.saveSession(session);
  assert.deepEqual(item.ownerSubjectHash, { S: 'a'.repeat(64) });
  assert.equal((await store.loadSession(session.sessionId))?.ownerSubjectHash, 'a'.repeat(64));
  item.ownerSubjectHash = { S: 'not-a-subject-hash' };
  assert.equal(await store.loadSession(session.sessionId), null);
});

test('sensitive-output suppression is backward-compatible durable session state', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access'; process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  let item: Record<string, any> = {};
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.Item) { item = request.Item; return new Response('{}'); }
    if (request.UpdateExpression) { item.sensitiveOutputSuppressed = request.ExpressionAttributeValues[':sensitive']; return new Response('{}'); }
    return new Response(JSON.stringify({ Item: item }));
  });
  await store.saveSession({ ...ownedSession, sensitiveOutputSuppressed: true });
  assert.deepEqual(item.sensitiveOutputSuppressed, { BOOL: true });
  assert.equal((await store.loadSession(ownedSession.sessionId))?.sensitiveOutputSuppressed, true);
  await store.saveSessionUnderLock({ ...ownedSession, sensitiveOutputSuppressed: false }, 'writer');
  assert.deepEqual(item.sensitiveOutputSuppressed, { BOOL: false });
});

test('capture bytes use immutable versioned browser-cloud S3 keys and owner-checked Dynamo metadata', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access'; process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'; process.env.CLOUD_BROWSER_ARTIFACT_BUCKET = 'synthetic-browser-artifacts';
  const bytes = Buffer.from([0, 255, 1, 2, 3]);
  const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  let item: Record<string, any> | undefined;
  let nowMs = 1_000;
  const calls: Array<{ url: string; method: string; request?: Record<string, any>; headers?: Headers }> = [];
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (url, init) => {
    const method = init?.method ?? '';
    const call = { url: String(url), method, headers: new Headers(init?.headers), ...(String(url).includes('dynamodb.') ? { request: JSON.parse(String(init?.body)) } : {}) };
    calls.push(call);
    if (call.request?.Item) { item = call.request.Item; return new Response('{}'); }
    if (call.request?.ConsistentRead) return new Response(JSON.stringify({ Item: item }));
    if (method === 'PUT') return new Response('', { headers: { 'x-amz-version-id': 's3-version-1' } });
    if (method === 'GET') return new Response(bytes, { headers: { 'x-amz-version-id': 's3-version-1', 'content-type': 'image/jpeg', 'content-length': String(bytes.length) } });
    return new Response('{}');
  }, () => nowMs);
  const metadata = await store.createCapture('cto', '123e4567-e89b-42d3-a456-426614174000', { contentType: 'image/jpeg', body: bytes, sha256 }, 1000, 'a'.repeat(64));
  assert.match(metadata.id, /^bca_[0-9a-f-]{36}$/);
  assert.equal(item?.pk.S, `CAPTURE#${metadata.id}`);
  assert.equal(item?.owner.S, 'cto');
  assert.equal(item?.storageKey.S, `browser-cloud/captures/cto/${metadata.id}`);
  assert.equal(item?.storageVersion.S, 's3-version-1');
  assert.deepEqual(item?.ownerSubjectHash, { S: 'a'.repeat(64) });
  const s3Put = calls.find(call => call.method === 'PUT')!;
  assert.equal(s3Put.headers?.get('if-none-match'), '*');
  assert.equal(s3Put.headers?.get('x-amz-server-side-encryption'), 'AES256');
  const s3CallCount = calls.filter(call => call.method === 'GET').length;
  assert.equal(await store.loadCapture('cfo', metadata.id), null);
  assert.equal(await store.loadCapture('cto', metadata.id, 'b'.repeat(64)), null, 'wrong subject is rejected before reading capture bytes');
  assert.equal(calls.filter(call => call.method === 'GET').length, s3CallCount);
  const loaded = await store.loadCapture('cto', metadata.id, 'a'.repeat(64));
  assert.deepEqual(loaded?.body, bytes);
  assert.equal(loaded?.metadata.sha256, sha256);
  const s3ReadsBeforeExpiry = calls.filter(call => call.method === 'GET').length;
  nowMs = Number(item?.expiresAtEpoch.N) * 1_000;
  assert.equal(await store.loadCapture('cto', metadata.id, 'a'.repeat(64)), null, 'capture must expire at its TTL boundary even before DynamoDB TTL cleanup');
  assert.equal(calls.filter(call => call.method === 'GET').length, s3ReadsBeforeExpiry, 'expired capture must be rejected before fetching S3 bytes');
});

function signedHeaderNames(headers: Headers): string[] {
  const authorization = headers.get('authorization');
  assert.ok(authorization, 'AWS request must include its SigV4 Authorization header');
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1];
  assert.ok(signedHeaders, 'SigV4 Authorization must declare SignedHeaders');
  return signedHeaders.split(';');
}

test('capture S3 PUT sends and signs the exact body SHA-256 header', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUD_BROWSER_ARTIFACT_BUCKET = 'synthetic-browser-artifacts';
  const body = Buffer.from([0, 255, 1, 2, 3]);
  const sha256 = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
  const calls: Array<{ url: string; method: string; headers: Headers; body?: Buffer }> = [];
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (url, init) => {
    const method = init?.method ?? '';
    calls.push({ url: String(url), method, headers: new Headers(init?.headers), ...(init?.body ? { body: Buffer.from(init.body as Uint8Array) } : {}) });
    if (String(url).includes('dynamodb.')) return new Response('{}');
    return new Response('', { headers: { 'x-amz-version-id': 'put-version-1' } });
  }, () => 1000);

  await store.createCapture('cto', '123e4567-e89b-42d3-a456-426614174000', { contentType: 'image/png', body, sha256 }, 1000);

  const put = calls.find((call) => call.method === 'PUT' && call.url.includes('.s3.'));
  assert.ok(put, 'capture body must be sent to S3');
  assert.deepEqual(put.body, body, 'the signed payload must be the exact capture bytes');
  assert.equal(put.headers.get('x-amz-content-sha256'), sha256);
  const signed = signedHeaderNames(put.headers);
  assert.ok(signed.includes('x-amz-content-sha256'));
  assert.ok(signed.includes('if-none-match'));
  assert.ok(signed.includes('x-amz-server-side-encryption'));
});

test('capture S3 GET sends and signs the empty payload hash with the immutable version query', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  process.env.CLOUD_BROWSER_ARTIFACT_BUCKET = 'synthetic-browser-artifacts';
  const body = Buffer.from([0, 255, 1, 2, 3]);
  const sha256 = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
  const emptySha256 = (await import('node:crypto')).createHash('sha256').update(new Uint8Array()).digest('hex');
  let item: Record<string, any> | undefined;
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (url, init) => {
    const method = init?.method ?? '';
    const call = { url: String(url), method, headers: new Headers(init?.headers) };
    calls.push(call);
    if (String(url).includes('dynamodb.') && method === 'POST') {
      const request = JSON.parse(String(init?.body));
      if (request.Item) { item = request.Item; return new Response('{}'); }
      if (request.ConsistentRead) return new Response(JSON.stringify({ Item: item }));
    }
    if (method === 'PUT') return new Response('', { headers: { 'x-amz-version-id': 's3-version-1' } });
    if (method === 'GET') return new Response(body, { headers: { 'x-amz-version-id': 's3-version-1', 'content-type': 'image/png', 'content-length': String(body.length) } });
    return new Response('{}');
  }, () => 1000);
  const metadata = await store.createCapture('cto', '123e4567-e89b-42d3-a456-426614174000', { contentType: 'image/png', body, sha256 }, 1000);

  const loaded = await store.loadCapture('cto', metadata.id);

  assert.deepEqual(loaded?.body, body);
  const get = calls.find((call) => call.method === 'GET' && call.url.includes('.s3.'));
  assert.ok(get, 'capture bytes must be read from S3');
  assert.match(get.url, /\?versionId=s3-version-1$/);
  assert.equal(get.headers.get('x-amz-content-sha256'), emptySha256);
  assert.ok(signedHeaderNames(get.headers).includes('x-amz-content-sha256'));
});


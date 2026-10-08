import { test } from 'node:test';
import assert from 'node:assert/strict';

// The logger imports the gateway env loader, which validates a few required variables at import time.
process.env.CIO_SITE_ID ??= 'synthetic';
process.env.CIO_TRACK_KEY ??= 'synthetic';
process.env.CIO_APP_API_BEARER ??= 'synthetic';
process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 's'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ??= 's'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ??= 's'.repeat(32);
// The fail-closed cases below log a warning by design; keep the test output readable.
process.env.LOG_LEVEL = 'fatal';

const {
  AWS_AI_ACCESS_SETUP_SCRIPT,
  AWS_AI_READER_ROLE_ARN_ENV,
  AWS_AI_READER_ROLE_NAME,
  AwsReaderUnavailableError,
  READER_CREDENTIAL_REFRESH_MARGIN_MS,
  createReaderCredentialProvider,
} = await import('./credentials.js');

// Synthetic values only: the account id is the AWS documentation example account.
const ACCOUNT = '111122223333';
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${AWS_AI_READER_ROLE_NAME}`;
const BASE = {
  accessKeyId: 'ASIA' + 'SYNTHETICBASE001',
  secretAccessKey: 'synthetic-base-secret-not-real',
  sessionToken: 'synthetic-base-session-token',
};
const T0 = Date.parse('2026-10-08T00:00:00Z');
const HOUR = 3600_000;

function identityXml(): string {
  return `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult>` +
    `<Arn>arn:aws:sts::${ACCOUNT}:assumed-role/syntheticTaskRole/task</Arn><UserId>AROASYNTHETIC:task</UserId><Account>${ACCOUNT}</Account>` +
    `</GetCallerIdentityResult></GetCallerIdentityResponse>`;
}

function assumeXml(opts: { expiresAtMs: number; roleName?: string; key?: string; omitToken?: boolean }): string {
  const key = opts.key ?? 'ASIA' + 'SYNTHETICREAD001';
  return `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials>` +
    `<AccessKeyId>${key}</AccessKeyId><SecretAccessKey>synthetic/reader+secret==</SecretAccessKey>` +
    (opts.omitToken ? '' : '<SessionToken>synthetic-reader-session-token</SessionToken>') +
    `<Expiration>${new Date(opts.expiresAtMs).toISOString()}</Expiration></Credentials>` +
    `<AssumedRoleUser><AssumedRoleId>AROASYNTHETIC:gw-cto-x</AssumedRoleId>` +
    `<Arn>arn:aws:sts::${ACCOUNT}:assumed-role/${opts.roleName ?? AWS_AI_READER_ROLE_NAME}/gw-cto-x</Arn></AssumedRoleUser>` +
    `</AssumeRoleResult></AssumeRoleResponse>`;
}

function errorXml(code: string, message = 'SYNTHETIC-PRIVATE-DETAIL arn:aws:iam::111122223333:role/x'): string {
  return `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>${code}</Code>` +
    `<Message>${message}</Message></Error><RequestId>req</RequestId></ErrorResponse>`;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  params: URLSearchParams;
}

/** A fake STS: replies per Action from the supplied handlers and records every request. */
function fakeSts(handlers: Partial<Record<'GetCallerIdentity' | 'AssumeRole', (n: number) => Response | Error>>): {
  fetchImpl: (url: string | URL, init?: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const seen = { GetCallerIdentity: 0, AssumeRole: 0 };
  return {
    calls,
    fetchImpl: async (url, init) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      calls.push({ url: String(url), method: String(init?.method), headers: init?.headers as Record<string, string>, params });
      const action = params.get('Action') as 'GetCallerIdentity' | 'AssumeRole';
      seen[action] += 1;
      const reply = handlers[action]?.(seen[action]);
      if (reply === undefined) throw new Error(`unexpected STS action ${action}`);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/xml' } });
}

function provider(fetchImpl: ReturnType<typeof fakeSts>['fetchImpl'], extra: { roleArn?: string } = {}) {
  let clock = T0;
  const p = createReaderCredentialProvider({
    baseCredentials: async () => BASE,
    fetchImpl,
    now: () => clock,
    ...extra,
  });
  return { p, advance: (ms: number) => { clock += ms; } };
}

test('assumes the reader role with the documented request shape and signs the STS calls with the base credentials', async () => {
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => xml(assumeXml({ expiresAtMs: T0 + HOUR })),
  });
  const { p } = provider(sts.fetchImpl);
  const creds = await p.get('4f1c-2a9b-77de-0123-456789abcdef');

  assert.deepEqual(sts.calls.map((c) => c.params.get('Action')), ['GetCallerIdentity', 'AssumeRole']);
  for (const call of sts.calls) {
    assert.equal(call.url, 'https://sts.us-east-1.amazonaws.com/');
    assert.equal(call.method, 'POST');
    assert.equal(call.params.get('Version'), '2011-06-15');
    assert.match(call.headers.Authorization, new RegExp(`^AWS4-HMAC-SHA256 Credential=${BASE.accessKeyId}/20261008/us-east-1/sts/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$`));
    assert.equal(call.headers['x-amz-security-token'], BASE.sessionToken);
    assert.equal(call.headers.host, 'sts.us-east-1.amazonaws.com');
  }
  const assume = sts.calls[1].params;
  assert.equal(assume.get('RoleArn'), ROLE_ARN);
  assert.equal(assume.get('RoleSessionName'), 'gw-cto-4f1c2a9b77de');
  assert.equal(assume.get('DurationSeconds'), '3600');

  assert.equal(creds.accessKeyId, 'ASIA' + 'SYNTHETICREAD001');
  assert.equal(creds.sessionToken, 'synthetic-reader-session-token');
  assert.equal(creds.expiresAtMs, T0 + HOUR);
  assert.notEqual(creds.accessKeyId, BASE.accessKeyId, 'the base credentials are never handed out');
  assert.notEqual(creds.secretAccessKey, BASE.secretAccessKey);
});

test('session names stay valid for STS even for an empty or unusual request id', async () => {
  const names: string[] = [];
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => xml(assumeXml({ expiresAtMs: T0 + HOUR })),
  });
  for (const hint of ['', '!!!', 'a'.repeat(200)]) {
    const { p } = provider(sts.fetchImpl);
    await p.get(hint);
    names.push(sts.calls[sts.calls.length - 1].params.get('RoleSessionName') ?? '');
  }
  for (const name of names) assert.match(name, /^gw-cto-[A-Za-z0-9]{1,12}$/);
});

test('credentials are cached until five minutes before expiry, then refreshed without a second identity lookup', async () => {
  let assumed = 0;
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => {
      assumed += 1;
      return xml(assumeXml({ expiresAtMs: T0 + HOUR + (assumed - 1) * HOUR, key: assumed === 1 ? 'ASIA' + 'SYNTHETICREAD001' : 'ASIA' + 'SYNTHETICREAD002' }));
    },
  });
  const { p, advance } = provider(sts.fetchImpl);

  const first = await p.get('req-1');
  advance(HOUR - READER_CREDENTIAL_REFRESH_MARGIN_MS - 1000);
  assert.equal((await p.get('req-2')).accessKeyId, first.accessKeyId, 'still inside the cache window');
  assert.equal(assumed, 1);

  advance(2000); // now within five minutes of expiry
  const refreshed = await p.get('req-3');
  assert.equal(assumed, 2);
  assert.equal(refreshed.accessKeyId, 'ASIA' + 'SYNTHETICREAD002');
  assert.equal(sts.calls.filter((c) => c.params.get('Action') === 'GetCallerIdentity').length, 1, 'the account id is looked up once');
});

test('concurrent callers share one AssumeRole', async () => {
  let assumed = 0;
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => {
      assumed += 1;
      return xml(assumeXml({ expiresAtMs: T0 + HOUR }));
    },
  });
  const { p } = provider(sts.fetchImpl);
  const results = await Promise.all([p.get('a'), p.get('b'), p.get('c'), p.get('d')]);
  assert.equal(assumed, 1);
  assert.equal(new Set(results.map((r) => r.accessKeyId)).size, 1);
});

test('FAIL CLOSED: an AssumeRole denial raises a safe message that names the owner script and leaks no STS detail', async () => {
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => xml(errorXml('AccessDenied'), 403),
  });
  const { p } = provider(sts.fetchImpl);
  await assert.rejects(p.get('req'), (err: unknown) => {
    assert.ok(err instanceof AwsReaderUnavailableError);
    assert.equal(err.reason, 'assume_role_failed');
    assert.equal(err.stsCode, 'AccessDenied');
    assert.match(err.message, /^aws_mcp_unavailable \(assume_role_failed, STS AccessDenied\)/);
    assert.ok(err.message.includes(AWS_AI_ACCESS_SETUP_SCRIPT), 'tells the CTO which script the owner must run');
    assert.ok(err.message.includes('AWS CloudShell'));
    assert.match(err.message, /No fallback credentials are used/);
    for (const forbidden of ['SYNTHETIC-PRIVATE-DETAIL', ACCOUNT, 'arn:aws', BASE.accessKeyId, BASE.secretAccessKey, BASE.sessionToken]) {
      assert.equal(err.message.includes(forbidden), false, `message must not contain ${forbidden}`);
    }
    return true;
  });
});

test('FAIL CLOSED: a failing refresh never falls back to the base credentials and is retried on the next call', async () => {
  let assumeCalls = 0;
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => {
      assumeCalls += 1;
      return assumeCalls === 1 ? xml(errorXml('AccessDenied'), 403) : xml(assumeXml({ expiresAtMs: T0 + HOUR }));
    },
  });
  const { p } = provider(sts.fetchImpl);
  await assert.rejects(p.get('req-1'), AwsReaderUnavailableError);
  const recovered = await p.get('req-2');
  assert.equal(recovered.accessKeyId, 'ASIA' + 'SYNTHETICREAD001');
  assert.equal(assumeCalls, 2);
});

test('FAIL CLOSED: no base credentials means no STS call at all', async () => {
  const sts = fakeSts({});
  const p = createReaderCredentialProvider({ baseCredentials: async () => null, fetchImpl: sts.fetchImpl, now: () => T0 });
  await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.reason === 'no_base_credentials');
  assert.equal(sts.calls.length, 0);
});

test('FAIL CLOSED: a base-credential resolver that throws is treated as no base credentials', async () => {
  const sts = fakeSts({});
  const p = createReaderCredentialProvider({
    baseCredentials: async () => { throw new Error('SYNTHETIC-RESOLVER-DETAIL'); },
    fetchImpl: sts.fetchImpl,
    now: () => T0,
  });
  await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && !err.message.includes('SYNTHETIC-RESOLVER-DETAIL'));
});

test('FAIL CLOSED: an unreachable STS surfaces as sts_unreachable without leaking the network error text', async () => {
  const sts = fakeSts({ GetCallerIdentity: () => new TypeError('fetch failed SYNTHETIC-NETWORK-DETAIL') });
  const { p } = provider(sts.fetchImpl);
  await assert.rejects(p.get('req'), (err: unknown) =>
    err instanceof AwsReaderUnavailableError && err.reason === 'sts_unreachable' && !err.message.includes('SYNTHETIC-NETWORK-DETAIL'));
});

test('FAIL CLOSED: a failed identity lookup is reported as caller_identity_failed with the STS code', async () => {
  const sts = fakeSts({ GetCallerIdentity: () => xml(errorXml('ExpiredToken'), 403) });
  const { p } = provider(sts.fetchImpl);
  await assert.rejects(p.get('req'), (err: unknown) =>
    err instanceof AwsReaderUnavailableError && err.reason === 'caller_identity_failed' && err.stsCode === 'ExpiredToken');
  assert.equal(sts.calls.length, 1, 'AssumeRole is never attempted without an account id');
});

test('FAIL CLOSED: a malformed or mismatched AssumeRole answer is refused', async () => {
  const cases: Array<[string, string]> = [
    ['missing session token', assumeXml({ expiresAtMs: T0 + HOUR, omitToken: true })],
    ['credentials for a different role', assumeXml({ expiresAtMs: T0 + HOUR, roleName: 'some-other-role' })],
    ['not credentials at all', '<AssumeRoleResponse></AssumeRoleResponse>'],
    ['unparseable expiry', assumeXml({ expiresAtMs: T0 + HOUR }).replace(/<Expiration>[^<]*<\/Expiration>/, '<Expiration>soon</Expiration>')],
  ];
  for (const [label, body] of cases) {
    const sts = fakeSts({ GetCallerIdentity: () => xml(identityXml()), AssumeRole: () => xml(body) });
    const { p } = provider(sts.fetchImpl);
    await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.reason === 'invalid_sts_response', label);
  }
});

test('AWS_AI_READER_ROLE_ARN overrides the derived role and skips the identity lookup', async () => {
  const override = `arn:aws:iam::${ACCOUNT}:role/service-path/custom-reader`;
  const sts = fakeSts({ AssumeRole: () => xml(assumeXml({ expiresAtMs: T0 + HOUR, roleName: 'custom-reader' })) });
  const previous = process.env[AWS_AI_READER_ROLE_ARN_ENV];
  process.env[AWS_AI_READER_ROLE_ARN_ENV] = override;
  try {
    const { p } = provider(sts.fetchImpl);
    await p.get('req');
    assert.deepEqual(sts.calls.map((c) => c.params.get('Action')), ['AssumeRole']);
    assert.equal(sts.calls[0].params.get('RoleArn'), override);
  } finally {
    if (previous === undefined) delete process.env[AWS_AI_READER_ROLE_ARN_ENV];
    else process.env[AWS_AI_READER_ROLE_ARN_ENV] = previous;
  }
});

test('FAIL CLOSED: an invalid override ARN is rejected before any STS call', async () => {
  for (const bad of ['not-an-arn', 'arn:aws:iam::123:role/x', `arn:aws-cn:iam::${ACCOUNT}:role/x`, `arn:aws:iam::${ACCOUNT}:user/someone`]) {
    const sts = fakeSts({});
    const { p } = provider(sts.fetchImpl, { roleArn: bad });
    await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.reason === 'invalid_role_arn', bad);
    assert.equal(sts.calls.length, 0);
  }
});

test('a transient refresh failure reuses still-valid reader credentials, but never expired ones', async () => {
  let assumeCalls = 0;
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => {
      assumeCalls += 1;
      return assumeCalls === 1 ? xml(assumeXml({ expiresAtMs: T0 + HOUR })) : new TypeError('fetch failed');
    },
  });
  const { p, advance } = provider(sts.fetchImpl);
  const first = await p.get('req-1');

  advance(HOUR - 3 * 60_000); // inside the refresh margin but not expired
  const reused = await p.get('req-2');
  assert.equal(reused.accessKeyId, first.accessKeyId);
  assert.equal(assumeCalls, 2, 'a refresh was attempted');

  advance(3 * 60_000 - 10_000); // fewer than 30 seconds of real validity left
  await assert.rejects(p.get('req-3'), (err: unknown) => err instanceof AwsReaderUnavailableError);
});

test('reset drops the cache', async () => {
  let assumed = 0;
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => {
      assumed += 1;
      return xml(assumeXml({ expiresAtMs: T0 + HOUR }));
    },
  });
  const { p } = provider(sts.fetchImpl);
  await p.get('a');
  p.reset();
  await p.get('b');
  assert.equal(assumed, 2);
});

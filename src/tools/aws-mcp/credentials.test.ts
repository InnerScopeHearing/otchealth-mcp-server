import { test, mock } from 'node:test';
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

const { logger } = await import('../../audit/logger.js');
const {
  AWS_AI_ACCESS_SETUP_POINTER,
  AWS_AI_ACCESS_SETUP_SCRIPT,
  AWS_AI_READER_ROLE_ARN_ENV,
  AWS_AI_READER_ROLE_NAME,
  AwsReaderUnavailableError,
  READER_CREDENTIAL_REFRESH_MARGIN_MS,
  READER_FAILURE_CACHE_MS,
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

function assumeXml(opts: { expiresAtMs: number; roleName?: string; key?: string; omitToken?: boolean; account?: string }): string {
  const key = opts.key ?? 'ASIA' + 'SYNTHETICREAD001';
  return `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials>` +
    `<AccessKeyId>${key}</AccessKeyId><SecretAccessKey>synthetic/reader+secret==</SecretAccessKey>` +
    (opts.omitToken ? '' : '<SessionToken>synthetic-reader-session-token</SessionToken>') +
    `<Expiration>${new Date(opts.expiresAtMs).toISOString()}</Expiration></Credentials>` +
    `<AssumedRoleUser><AssumedRoleId>AROASYNTHETIC:gw-cto-x</AssumedRoleId>` +
    `<Arn>arn:aws:sts::${opts.account ?? ACCOUNT}:assumed-role/${opts.roleName ?? AWS_AI_READER_ROLE_NAME}/gw-cto-x</Arn></AssumedRoleUser>` +
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
  assert.equal(creds.roleArn, ROLE_ARN, 'the credentials report the role that was actually assumed');
  assert.equal(creds.roleSessionName, 'gw-cto-4f1c2a9b77de', 'and the session name sent to STS');
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
    assert.ok(
      err.message.includes('InnerScopeHearing/otchealth-claude-tools setup/iam/aws-ai-access-2026-10-07.sh (owner-run CloudShell step)'),
      'names the repository, the script and that it is an owner-run CloudShell step',
    );
    assert.equal(AWS_AI_ACCESS_SETUP_POINTER, 'InnerScopeHearing/otchealth-claude-tools setup/iam/aws-ai-access-2026-10-07.sh (owner-run CloudShell step)');
    assert.match(err.message, /No fallback credentials are used/);
    for (const forbidden of ['SYNTHETIC-PRIVATE-DETAIL', ACCOUNT, 'arn:aws', BASE.accessKeyId, BASE.secretAccessKey, BASE.sessionToken]) {
      assert.equal(err.message.includes(forbidden), false, `message must not contain ${forbidden}`);
    }
    return true;
  });
});

test('FAIL CLOSED: a failing refresh never falls back to the base credentials, is answered from the failure cache for 60 seconds, and is retried after that', async () => {
  let assumeCalls = 0;
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => {
      assumeCalls += 1;
      return assumeCalls === 1 ? xml(errorXml('AccessDenied'), 403) : xml(assumeXml({ expiresAtMs: T0 + 3 * HOUR }));
    },
  });
  const { p, advance } = provider(sts.fetchImpl);
  await assert.rejects(p.get('req-1'), AwsReaderUnavailableError);
  const callsAfterFailure = sts.calls.length;

  // Inside the window the owner may already have fixed the role, but STS is not asked again.
  await assert.rejects(p.get('req-2'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.cached);
  assert.equal(sts.calls.length, callsAfterFailure, 'no STS call inside the window');
  assert.equal(assumeCalls, 1);

  advance(READER_FAILURE_CACHE_MS);
  const recovered = await p.get('req-3');
  assert.equal(recovered.accessKeyId, 'ASIA' + 'SYNTHETICREAD001');
  assert.equal(assumeCalls, 2);
  assert.equal((await p.get('req-4')).accessKeyId, recovered.accessKeyId, 'a success clears the failure and is then cached normally');
  assert.equal(assumeCalls, 2);
});

test('NEGATIVE CACHE: the cached answer keeps the original reason and STS code, counts down, expires at exactly 60 seconds, and reset() clears it', async () => {
  assert.equal(READER_FAILURE_CACHE_MS, 60_000);
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => xml(errorXml('AccessDenied'), 403),
  });
  const { p, advance } = provider(sts.fetchImpl);

  await assert.rejects(p.get('req-1'), (err: unknown) => {
    assert.ok(err instanceof AwsReaderUnavailableError);
    assert.equal(err.cached, false);
    assert.equal(err.retryAfterSeconds, undefined);
    assert.equal(err.message.includes('cached'), false, 'the first answer is the live one');
    return true;
  });
  const calls = sts.calls.length;

  advance(10_000);
  await assert.rejects(p.get('req-2'), (err: unknown) => {
    assert.ok(err instanceof AwsReaderUnavailableError);
    assert.equal(err.cached, true);
    assert.equal(err.reason, 'assume_role_failed');
    assert.equal(err.stsCode, 'AccessDenied');
    assert.equal(err.retryAfterSeconds, 50);
    assert.match(err.message, /^aws_mcp_unavailable \(assume_role_failed, STS AccessDenied\)/);
    assert.match(err.message, /This failure is cached, so STS is not called again for about 50 more second\(s\)\./);
    assert.ok(err.message.includes(AWS_AI_ACCESS_SETUP_POINTER));
    return true;
  });
  advance(49_001);
  await assert.rejects(p.get('req-3'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.cached && err.retryAfterSeconds === 1);
  assert.equal(sts.calls.length, calls, 'still no STS call 59.001 seconds after the failure');

  advance(999); // exactly 60 seconds after the failure
  await assert.rejects(p.get('req-4'), (err: unknown) => err instanceof AwsReaderUnavailableError && !err.cached);
  assert.equal(sts.calls.length, calls + 1, 'the window is over, so STS is asked again (the account id is already known)');
  assert.equal(sts.calls.at(-1)?.params.get('Action'), 'AssumeRole');

  // reset() forgets the failure window as well as the credentials.
  await assert.rejects(p.get('req-5'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.cached);
  p.reset();
  const before = sts.calls.length;
  await assert.rejects(p.get('req-6'), (err: unknown) => err instanceof AwsReaderUnavailableError && !err.cached);
  assert.ok(sts.calls.length > before, 'after reset the next call goes to STS');
});

test('NEGATIVE CACHE: concurrent callers share one failing refresh, and callers that arrive after it are answered from the cache', async () => {
  let assumeCalls = 0;
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => {
      assumeCalls += 1;
      return xml(errorXml('Throttling'), 400);
    },
  });
  const { p } = provider(sts.fetchImpl);
  const results = await Promise.allSettled([p.get('a'), p.get('b'), p.get('c')]);
  assert.equal(assumeCalls, 1, 'one AssumeRole for three concurrent callers');
  for (const r of results) assert.ok(r.status === 'rejected' && r.reason instanceof AwsReaderUnavailableError && r.reason.stsCode === 'Throttling');
  await assert.rejects(p.get('d'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.cached);
  assert.equal(assumeCalls, 1);
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
    ['credentials for a role in a different account', assumeXml({ expiresAtMs: T0 + HOUR, account: '444455556666' })],
    ['not credentials at all', '<AssumeRoleResponse></AssumeRoleResponse>'],
    ['unparseable expiry', assumeXml({ expiresAtMs: T0 + HOUR }).replace(/<Expiration>[^<]*<\/Expiration>/, '<Expiration>soon</Expiration>')],
  ];
  for (const [label, body] of cases) {
    const sts = fakeSts({ GetCallerIdentity: () => xml(identityXml()), AssumeRole: () => xml(body) });
    const { p } = provider(sts.fetchImpl);
    await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.reason === 'invalid_sts_response', label);
  }
});

test('ROLE PIN: AWS_AI_READER_ROLE_ARN may spell the pinned role with an IAM path, and the account is still verified first', async () => {
  const override = `arn:aws:iam::${ACCOUNT}:role/service-path/${AWS_AI_READER_ROLE_NAME}`;
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => xml(assumeXml({ expiresAtMs: T0 + HOUR })),
  });
  const previous = process.env[AWS_AI_READER_ROLE_ARN_ENV];
  process.env[AWS_AI_READER_ROLE_ARN_ENV] = `  ${override}  `; // surrounding whitespace is ignored
  try {
    const { p } = provider(sts.fetchImpl);
    const creds = await p.get('req');
    assert.deepEqual(sts.calls.map((c) => c.params.get('Action')), ['GetCallerIdentity', 'AssumeRole']);
    assert.equal(sts.calls[1].params.get('RoleArn'), override);
    assert.equal(creds.roleArn, override, 'the reported role is the one actually assumed');
  } finally {
    if (previous === undefined) delete process.env[AWS_AI_READER_ROLE_ARN_ENV];
    else process.env[AWS_AI_READER_ROLE_ARN_ENV] = previous;
  }
});

test('ROLE PIN: a path of several segments is allowed, and the role name is always the last segment', async () => {
  for (const path of ['a', 'a/b', 'division_abc/subdivision_xyz/product_1234', 'svc+=,.@-_']) {
    const override = `arn:aws:iam::${ACCOUNT}:role/${path}/${AWS_AI_READER_ROLE_NAME}`;
    const sts = fakeSts({ GetCallerIdentity: () => xml(identityXml()), AssumeRole: () => xml(assumeXml({ expiresAtMs: T0 + HOUR })) });
    const { p } = provider(sts.fetchImpl, { roleArn: override });
    assert.equal((await p.get('req')).roleArn, override, path);
  }
});

test('FAIL CLOSED: an invalid override ARN is rejected before any STS call', async () => {
  for (const bad of [
    'not-an-arn',
    'arn:aws:iam::123:role/x',
    `arn:aws-cn:iam::${ACCOUNT}:role/x`,
    `arn:aws:iam::${ACCOUNT}:user/someone`,
    `arn:aws:iam::${ACCOUNT}:role/`,
    `arn:aws:iam::${ACCOUNT}:role//${AWS_AI_READER_ROLE_NAME}`,
    `arn:aws:iam::${ACCOUNT}:role/bad path/${AWS_AI_READER_ROLE_NAME}`,
    `arn:aws:iam::${ACCOUNT}:role/${AWS_AI_READER_ROLE_NAME}/`,
    `arn:aws:iam::${ACCOUNT}:role/${AWS_AI_READER_ROLE_NAME}\nx`,
  ]) {
    const sts = fakeSts({});
    const { p } = provider(sts.fetchImpl, { roleArn: bad });
    await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.reason === 'invalid_role_arn', JSON.stringify(bad));
    assert.equal(sts.calls.length, 0);
  }
});

test('ROLE PIN: any role name other than the reader role is refused before any STS call, and the name is not echoed', async () => {
  for (const name of [
    'custom-reader',
    'other-role',
    'Otchealth-AI-Reader-Role',
    `${AWS_AI_READER_ROLE_NAME}-2`,
    `x-${AWS_AI_READER_ROLE_NAME}`,
    `${AWS_AI_READER_ROLE_NAME}.bak`,
    'AdministratorAccess',
  ]) {
    const sts = fakeSts({});
    const { p } = provider(sts.fetchImpl, { roleArn: `arn:aws:iam::${ACCOUNT}:role/${name}` });
    await assert.rejects(p.get('req'), (err: unknown) => {
      assert.ok(err instanceof AwsReaderUnavailableError);
      assert.equal(err.reason, 'role_name_not_allowed', name);
      assert.equal(err.message.includes(name), false, `the rejected name ${name} is not echoed`);
      assert.equal(err.message.includes(ACCOUNT), false);
      return true;
    }, name);
    assert.equal(sts.calls.length, 0, `no STS call for ${name}`);
  }
  // The reader role named only as a path segment does not count: the name is the last segment.
  const sts = fakeSts({});
  const { p } = provider(sts.fetchImpl, { roleArn: `arn:aws:iam::${ACCOUNT}:role/${AWS_AI_READER_ROLE_NAME}/admin` });
  await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.reason === 'role_name_not_allowed');
  assert.equal(sts.calls.length, 0);
});

test('ROLE PIN: a role in a different account than the gateway task role is refused after the account lookup and before AssumeRole', async () => {
  const sts = fakeSts({ GetCallerIdentity: () => xml(identityXml()) });
  const { p } = provider(sts.fetchImpl, { roleArn: `arn:aws:iam::444455556666:role/${AWS_AI_READER_ROLE_NAME}` });
  await assert.rejects(p.get('req'), (err: unknown) => {
    assert.ok(err instanceof AwsReaderUnavailableError);
    assert.equal(err.reason, 'role_account_mismatch');
    assert.equal(err.message.includes('444455556666'), false, 'the foreign account id is not echoed');
    assert.equal(err.message.includes(ACCOUNT), false);
    return true;
  });
  assert.deepEqual(sts.calls.map((c) => c.params.get('Action')), ['GetCallerIdentity'], 'AssumeRole was never sent');
});

test('ROLE PIN: without an override the default role in the task account is assumed and reported', async () => {
  const sts = fakeSts({ GetCallerIdentity: () => xml(identityXml()), AssumeRole: () => xml(assumeXml({ expiresAtMs: T0 + HOUR })) });
  const previous = process.env[AWS_AI_READER_ROLE_ARN_ENV];
  delete process.env[AWS_AI_READER_ROLE_ARN_ENV];
  try {
    const { p } = provider(sts.fetchImpl);
    const creds = await p.get('req');
    assert.equal(sts.calls[1].params.get('RoleArn'), ROLE_ARN);
    assert.equal(creds.roleArn, ROLE_ARN);
  } finally {
    if (previous !== undefined) process.env[AWS_AI_READER_ROLE_ARN_ENV] = previous;
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

  advance(30_000); // inside the 60 second failure window, still valid for 2.5 minutes
  assert.equal((await p.get('req-2b')).accessKeyId, first.accessKeyId);
  assert.equal(assumeCalls, 2, 'no further STS call inside the failure window');

  advance(3 * 60_000 - 40_000); // the window is over and fewer than 30 seconds of real validity are left
  await assert.rejects(p.get('req-3'), (err: unknown) => err instanceof AwsReaderUnavailableError);
  assert.equal(assumeCalls, 3, 'the window ended, so STS was asked once more');
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

test('each AssumeRole logs its RoleSessionName, and nothing secret', async () => {
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => xml(assumeXml({ expiresAtMs: T0 + HOUR })),
  });
  const lines: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const spies = (['info', 'warn', 'error'] as const).map((level) =>
    mock.method(logger, level, (fields: unknown) => {
      lines.push({ level, fields: fields as Record<string, unknown> });
    }),
  );
  try {
    const { p } = provider(sts.fetchImpl);
    await p.get('4f1c-2a9b-77de-0123-456789abcdef');
    await p.get('cached-so-no-second-assume');
  } finally {
    for (const spy of spies) spy.mock.restore();
  }
  const assumeLines = lines.filter((l) => l.fields.type === 'aws_mcp_assume_role');
  assert.equal(assumeLines.length, 1, 'one AssumeRole, one line (the cached call logs nothing)');
  assert.deepEqual(assumeLines[0].fields, {
    type: 'aws_mcp_assume_role',
    role_name: AWS_AI_READER_ROLE_NAME,
    role_session_name: 'gw-cto-4f1c2a9b77de',
    duration_seconds: 3600,
  });
  assert.equal(assumeLines[0].fields.role_session_name, sts.calls[1].params.get('RoleSessionName'), 'the logged name is the one STS received');
  const everything = JSON.stringify(lines);
  for (const forbidden of [BASE.accessKeyId, BASE.secretAccessKey, BASE.sessionToken, 'synthetic-reader-session-token', 'synthetic/reader+secret==', ACCOUNT, 'Signature=']) {
    assert.equal(everything.includes(forbidden), false, `a log line carries ${forbidden}`);
  }
});

test('a refresh failure logs the reason and STS code only, and a throwing log sink changes nothing', async () => {
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => xml(errorXml('AccessDenied'), 403),
  });
  const lines: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const warn = mock.method(logger, 'warn', (fields: unknown) => {
    lines.push({ level: 'warn', fields: fields as Record<string, unknown> });
  });
  try {
    const { p } = provider(sts.fetchImpl);
    await assert.rejects(p.get('req'), AwsReaderUnavailableError);
  } finally {
    warn.mock.restore();
  }
  assert.deepEqual(lines.map((l) => l.fields), [{ type: 'aws_mcp_reader_unavailable', reason: 'assume_role_failed', sts_code: 'AccessDenied' }]);
  assert.equal(JSON.stringify(lines).includes('SYNTHETIC-PRIVATE-DETAIL'), false);

  const sinks = (['info', 'warn'] as const).map((level) => mock.method(logger, level, () => { throw new Error('log sink is down'); }));
  try {
    const ok = fakeSts({ GetCallerIdentity: () => xml(identityXml()), AssumeRole: () => xml(assumeXml({ expiresAtMs: T0 + HOUR })) });
    assert.equal((await provider(ok.fetchImpl).p.get('req')).accessKeyId, 'ASIA' + 'SYNTHETICREAD001', 'a throwing log sink does not break a refresh');
    const denied = fakeSts({ GetCallerIdentity: () => xml(identityXml()), AssumeRole: () => xml(errorXml('AccessDenied'), 403) });
    const { p } = provider(denied.fetchImpl);
    await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.reason === 'assume_role_failed' && err.stsCode === 'AccessDenied');
    await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.cached, 'and the failure is still cached');
  } finally {
    for (const sink of sinks) sink.mock.restore();
  }
});

// ---------------------------------------------------------------------------------------------
// The STS response size cap is enforced while the body streams
// ---------------------------------------------------------------------------------------------
const STS_CAP_BYTES = 64 * 1024;

/** A response whose body is a stream of `chunks` chunks of `chunkBytes` bytes, produced on demand and counted. */
function streamingResponse(opts: { chunks: number; chunkBytes: number; headers?: Record<string, string>; status?: number }) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(opts.chunkBytes).fill('a'.charCodeAt(0));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= opts.chunks) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { state, response: new Response(body, { status: opts.status ?? 200, headers: { 'content-type': 'text/xml', ...opts.headers } }) };
}

test('SIZE CAP: an oversized STS body without a length header is cut off while streaming, not read to the end', async () => {
  const big = streamingResponse({ chunks: 100_000, chunkBytes: 1024 }); // 100 MB if it were read to the end
  const sts = fakeSts({ GetCallerIdentity: () => big.response });
  const { p } = provider(sts.fetchImpl);
  await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.reason === 'invalid_sts_response');
  assert.equal(big.state.cancelled, true, 'the rest of the stream was cancelled');
  assert.ok(big.state.pulled <= STS_CAP_BYTES / 1024 + 3, `only about the cap was pulled, not the whole body (pulled ${big.state.pulled} chunks)`);
  assert.equal(sts.calls.length, 1, 'AssumeRole is never attempted after a bad identity answer');
});

test('SIZE CAP: a declared length over the cap is refused without reading the body', async () => {
  const declared = streamingResponse({ chunks: 1_000, chunkBytes: 1024, headers: { 'content-length': String(STS_CAP_BYTES + 1) } });
  const sts = fakeSts({ GetCallerIdentity: () => xml(identityXml()), AssumeRole: () => declared.response });
  const { p } = provider(sts.fetchImpl);
  await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.reason === 'invalid_sts_response');
  assert.equal(declared.state.cancelled, true);
  assert.ok(declared.state.pulled <= 2, `the body was not consumed (pulled ${declared.state.pulled})`);
});

test('SIZE CAP: an oversized error body is also cut off, and fails closed with a distinct reason', async () => {
  const big = streamingResponse({ chunks: 100_000, chunkBytes: 1024, status: 403 });
  const sts = fakeSts({ GetCallerIdentity: () => xml(identityXml()), AssumeRole: () => big.response });
  const { p } = provider(sts.fetchImpl);
  await assert.rejects(p.get('req'), (err: unknown) => err instanceof AwsReaderUnavailableError && err.reason === 'invalid_sts_response');
  assert.equal(big.state.cancelled, true);
  assert.ok(big.state.pulled <= STS_CAP_BYTES / 1024 + 3);
});

test('SIZE CAP: a normal multi-chunk answer under the cap is read in full, including a multi-byte character split across chunks', async () => {
  const text = assumeXml({ expiresAtMs: T0 + HOUR }).replace('<AssumeRoleResult>', '<AssumeRoleResult><Note>caf' + String.fromCharCode(0xe9) + '</Note>');
  const bytes = Buffer.from(text, 'utf8');
  const split = bytes.indexOf(Buffer.from([0xc3])) + 1; // between the two bytes of the encoded e-acute
  assert.ok(split > 0);
  const parts = [bytes.subarray(0, split), bytes.subarray(split, split + 40), bytes.subarray(split + 40)];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new Uint8Array(part));
      controller.close();
    },
  });
  const sts = fakeSts({
    GetCallerIdentity: () => xml(identityXml()),
    AssumeRole: () => new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } }),
  });
  const { p } = provider(sts.fetchImpl);
  const creds = await p.get('req');
  assert.equal(creds.accessKeyId, 'ASIA' + 'SYNTHETICREAD001');
  assert.equal(creds.expiresAtMs, T0 + HOUR);
});

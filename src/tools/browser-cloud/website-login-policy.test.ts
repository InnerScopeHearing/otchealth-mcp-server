import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWebsiteLoginTargetPublic, matchesWebsiteLoginTarget, resolveWebsiteLoginTarget,
  validateWebsiteLoginTarget, type WebsiteLoginPolicyDependencies,
} from './website-login-policy.js';

const publicDns: WebsiteLoginPolicyDependencies = { lookup: async () => [
  { address: '93.184.215.14', family: 4 }, { address: '2606:4700:4700::1111', family: 6 },
] };
const code = (expected: string) => (error: unknown): boolean =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === expected;

test('arbitrary public website target is canonical, immutable, and deterministic across exact-host order', async () => {
  const first = await resolveWebsiteLoginTarget({ url: 'https://Portal.Example.com/workspace', allowed_hosts: ['sso.example.com', 'PORTAL.EXAMPLE.COM'] }, publicDns);
  const second = await resolveWebsiteLoginTarget({ url: 'https://portal.example.com/workspace', allowed_hosts: ['portal.example.com', 'sso.example.com', 'sso.example.com'] }, publicDns);
  assert.deepEqual(first, second);
  assert.equal(first.origin, 'https://portal.example.com');
  assert.equal(first.expectedPathname, '/workspace');
  assert.deepEqual(first.allowedHosts, ['portal.example.com', 'sso.example.com']);
  assert.match(first.siteKey, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.allowedHosts), true);
  assert.deepEqual(validateWebsiteLoginTarget(JSON.parse(JSON.stringify(first))), first);
  const changedPath = await resolveWebsiteLoginTarget({ url: 'https://portal.example.com/other', allowed_hosts: first.allowedHosts }, publicDns);
  const changedHost = await resolveWebsiteLoginTarget({ url: 'https://portal.example.com/workspace' }, publicDns);
  assert.notEqual(first.siteKey, changedPath.siteKey);
  assert.notEqual(first.siteKey, changedHost.siteKey);
});

test('target rejects credentials, callback secrets, unsafe schemes, ports and malformed paths before DNS', async () => {
  let dnsCalls = 0;
  const deps = { lookup: async () => { dnsCalls++; return [{ address: '93.184.215.14', family: 4 }]; } };
  for (const url of [
    'http://portal.example.com/', 'file:///etc/passwd', 'javascript:alert(1)',
    'https://user:password@portal.example.com/', 'https://user@portal.example.com/',
    'https://portal.example.com:8443/', 'https://portal.example.com/?code=secret',
    'https://portal.example.com/#access_token=secret', 'https://portal.example.com/?',
    'https://portal.example.com/#', ' https://portal.example.com/',
    'https://portal.example.com/\npath', 'https://portal.example.com/\\other',
    'https://portal.example.com/%00path', 'https://portal.example.com/%1fpath',
    'https://portal.example.com/%7fpath', `https://portal.example.com/${'a'.repeat(1025)}`,
  ]) await assert.rejects(resolveWebsiteLoginTarget({ url }, deps), code('website_target_invalid'));
  assert.equal(dnsCalls, 0);
});

test('target rejects private, metadata, literal-address and wildcard hosts before DNS', async () => {
  let dnsCalls = 0;
  const deps = { lookup: async () => { dnsCalls++; return [{ address: '93.184.215.14', family: 4 }]; } };
  for (const host of [
    'localhost', 'sub.localhost', 'metadata.google.internal', 'host.local', 'host.lan', 'host.home',
    'host.corp', 'host.invalid', 'host.test', 'host.example', 'host.onion', 'host.arpa',
    '127.0.0.1', '169.254.169.254', '2130706433', '0x7f000001', '127.1', '[::1]',
    '[fd00:ec2::254]', 'example.com.', '*.example.com', 'service', 'foo.123',
  ]) await assert.rejects(resolveWebsiteLoginTarget({ url: `https://${host}/` }, deps), code('website_target_invalid'));
  for (const host of ['localhost', '*.example.com', 'https://sso.example.com', 'sso.example.com/path', 'sso.example.com:443', 'sso.example.com.']) {
    await assert.rejects(resolveWebsiteLoginTarget({ url: 'https://portal.example.com/', allowed_hosts: [host] }, deps), code('website_target_invalid'));
  }
  assert.equal(dnsCalls, 0);
});

test('every DNS answer of every allowed host must be public and address families must agree', async () => {
  for (const [address, family] of [
    ['0.0.0.0', 4], ['10.1.2.3', 4], ['100.64.0.1', 4], ['127.0.0.1', 4], ['169.254.169.254', 4],
    ['172.16.1.2', 4], ['192.0.0.1', 4], ['192.0.2.1', 4], ['192.88.99.1', 4], ['192.168.1.1', 4],
    ['198.18.0.1', 4], ['198.51.100.1', 4], ['203.0.113.1', 4], ['224.0.0.1', 4], ['255.255.255.255', 4],
    ['::', 6], ['::1', 6], ['::ffff:127.0.0.1', 6], ['::ffff:7f00:1', 6], ['fd00:ec2::254', 6], ['fe80::1', 6],
    ['ff02::1', 6], ['2001:db8::1', 6], ['2001::1', 6], ['2002:7f00:1::1', 6], ['3fff::1', 6],
    ['not-an-address', 4], ['93.184.215.14', 6], ['2606:4700:4700::1111', 4],
  ] as const) {
    await assert.rejects(resolveWebsiteLoginTarget({ url: 'https://portal.example.com/' }, { lookup: async () => [
      { address: '93.184.215.14', family: 4 }, { address, family },
    ] }), code('website_target_not_public'));
  }
  const queried: string[] = [];
  await assert.rejects(resolveWebsiteLoginTarget({ url: 'https://portal.example.com/', allowed_hosts: ['sso.example.com'] }, {
    lookup: async host => { queried.push(host); return [{ address: host === 'sso.example.com' ? '169.254.169.254' : '93.184.215.14', family: 4 }]; },
  }), code('website_target_not_public'));
  assert.deepEqual(queried.sort(), ['portal.example.com', 'sso.example.com']);
});

test('DNS failures, empty results and deadlines fail closed without retaining resolver data', async () => {
  for (const lookup of [
    async () => [],
    async () => { throw new Error('dns-secret-error'); },
    async () => new Promise<never>(() => {}),
    async () => Array.from({ length: 65 }, () => ({ address: '93.184.215.14', family: 4 })),
  ]) await assert.rejects(resolveWebsiteLoginTarget({ url: 'https://portal.example.com/' }, { lookup, dnsTimeoutMs: 5 }), error =>
    code('website_target_not_public')(error) && !String(error).includes('dns-secret-error'));
});

test('persisted targets reject forged identities, noncanonical hosts and unknown fields', async () => {
  const target = await resolveWebsiteLoginTarget({ url: 'https://portal.example.com/workspace', allowed_hosts: ['sso.example.com'] }, publicDns);
  for (const mutation of [
    { ...target, origin: 'https://other.example.com' }, { ...target, origin: `${target.origin}/` },
    { ...target, expectedPathname: '/other' }, { ...target, siteKey: 'a'.repeat(64) },
    { ...target, allowedHosts: [...target.allowedHosts].reverse() },
    { ...target, allowedHosts: [...target.allowedHosts, target.allowedHosts[0]] },
    { ...target, allowedHosts: ['PORTAL.EXAMPLE.COM', 'sso.example.com'] },
    { ...target, allowedHosts: ['sso.example.com'] }, { ...target, password: 'never-persist' },
    { ...target, expectedPathname: '/workspace?code=secret' },
    { ...target, expectedPathname: '//other.example.com/workspace' },
    null, [], {},
  ]) assert.throws(() => validateWebsiteLoginTarget(mutation), code('website_target_invalid'));
  await assert.rejects(assertWebsiteLoginTargetPublic({ ...target, siteKey: 'a'.repeat(64) }, publicDns), code('website_target_invalid'));
});

test('observed URL check accepts only the bound origin and exact pathname, without capturing query secrets', async () => {
  const target = await resolveWebsiteLoginTarget({ url: 'https://portal.example.com/workspace', allowed_hosts: ['sso.example.com'] }, publicDns);
  assert.equal(matchesWebsiteLoginTarget('https://portal.example.com/workspace', target), true);
  assert.equal(matchesWebsiteLoginTarget('https://portal.example.com/workspace?session=secret#state', target), true);
  for (const url of [
    'https://portal.example.com/workspace/', 'https://portal.example.com/workspace/child',
    'https://sso.example.com/workspace', 'https://portal.example.com/login',
    'http://portal.example.com/workspace', 'https://portal.example.com:8443/workspace',
    'https://user:password@portal.example.com/workspace', 'https://evil.example.com/workspace',
    'https://portal.example.com/workspace\n', null, {},
  ]) assert.equal(matchesWebsiteLoginTarget(url, target), false);
  assert.equal(JSON.stringify(target).includes('secret'), false);
});

test('host count bound includes the destination host and rejects unknown caller fields', async () => {
  const allowed_hosts = Array.from({ length: 24 }, (_value, index) => `sso${index}.example.com`);
  await assert.rejects(resolveWebsiteLoginTarget({ url: 'https://portal.example.com/', allowed_hosts }, publicDns), code('website_target_invalid'));
  const target = await resolveWebsiteLoginTarget({ url: 'https://portal.example.com/', allowed_hosts: allowed_hosts.slice(0, 23) }, publicDns);
  assert.equal(target.allowedHosts.length, 24);
  await assert.rejects(resolveWebsiteLoginTarget({ url: 'https://portal.example.com/', siteKey: 'caller-selected' } as never, publicDns), code('website_target_invalid'));
});

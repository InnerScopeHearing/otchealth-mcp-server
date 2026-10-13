import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudBrowserError, type CloudBrowserProfile } from './contract.js';
import { assertTrustedPublicWebProfile, parseTrustedPublicWebPolicy } from './public-web-policy.js';

const env = {
  AWS_REGION: 'us-east-1',
  CLOUD_BROWSER_PUBLIC_WEB_CUSTOM_BROWSER_IDENTIFIER: 'browser_public_01',
  CLOUD_BROWSER_PUBLIC_WEB_NETWORK_POLICY_VERSION: 'egress-v3',
  CLOUD_BROWSER_PUBLIC_WEB_PRIVATE_HOST_POLICY: 'verified-proxy-acl-v2',
  CLOUD_BROWSER_PUBLIC_WEB_PROXY_SERVER: '10.20.30.40',
  CLOUD_BROWSER_PUBLIC_WEB_PROXY_PORT: '3128',
};
const policy = parseTrustedPublicWebPolicy(env)!;

function profile(overrides: Partial<CloudBrowserProfile> = {}): CloudBrowserProfile {
  return {
    profileId: 'cto-public-web',
    owner: 'cto',
    allowedHosts: [],
    persistent: false,
    mode: 'public_web',
    customBrowserIdentifier: policy.customBrowserIdentifier,
    networkPolicyVersion: policy.networkPolicyVersion,
    privateHostPolicy: policy.privateHostPolicy,
    proxyConfiguration: { proxies: [{ externalProxy: { server: policy.proxyServer, port: policy.proxyPort } }] },
    actionBudget: 100,
    maxSessionSeconds: 180,
    maxActionSeconds: 30,
    ...overrides,
  };
}

function rejectsProfile(value: CloudBrowserProfile, runtimeRegion = 'us-east-1'): void {
  assert.throws(() => assertTrustedPublicWebProfile(value, policy, runtimeRegion), (error: unknown) =>
    error instanceof CloudBrowserError && error.code === 'public_network_policy_unverified');
}

test('parses exact trusted pins only when the normal AWS browser region and complete endpoint are explicit', () => {
  assert.equal(policy.region, 'us-east-1');
  assert.equal(policy.proxyServer, '10.20.30.40');
  assert.equal(policy.proxyPort, 3128);
  assert.equal(parseTrustedPublicWebPolicy({ ...env, AWS_REGION: undefined }), undefined);
  assert.equal(parseTrustedPublicWebPolicy({ ...env, CLOUD_BROWSER_PUBLIC_WEB_PROXY_PORT: '0' }), undefined);
  assert.equal(parseTrustedPublicWebPolicy({ ...env, CLOUD_BROWSER_PUBLIC_WEB_PROXY_SERVER: '127.0.0.1' }), undefined);
  assert.equal(parseTrustedPublicWebPolicy({ ...env, CLOUD_BROWSER_PUBLIC_WEB_PROXY_SERVER: 'http://proxy.internal' }), undefined);
});

test('accepts the exact private proxy host and public-web receipt pins', () => {
  assert.doesNotThrow(() => assertTrustedPublicWebProfile(profile(), policy, 'us-east-1'));
});

test('rejects arbitrary browser identifiers, network versions, private-host receipts and runtime regions', () => {
  rejectsProfile(profile({ customBrowserIdentifier: 'attacker-browser' }));
  rejectsProfile(profile({ networkPolicyVersion: 'unverified' }));
  rejectsProfile(profile({ privateHostPolicy: 'some-string-is-not-proof' }));
  assert.throws(() => assertTrustedPublicWebProfile(profile(), policy, 'us-west-2'), /trusted runtime configuration/);
});

test('rejects loopback, mismatched proxy port, bypass and all unrecognized proxy fields', () => {
  rejectsProfile(profile({ proxyConfiguration: { proxies: [{ externalProxy: { server: '127.0.0.1', port: 3128 } }] } }));
  rejectsProfile(profile({ proxyConfiguration: { proxies: [{ externalProxy: { server: '10.20.30.40', port: 8080 } }] } }));
  rejectsProfile(profile({ proxyConfiguration: { proxies: [{ externalProxy: { server: '10.20.30.40', port: 3128 } }], bypass: { domainPatterns: ['.example.com'] } } }));
  rejectsProfile(profile({ proxyConfiguration: { proxies: [{ externalProxy: { server: '10.20.30.40', port: 3128, username: 'unexpected' } }] } }));
  rejectsProfile(profile({ proxyConfiguration: { proxies: [{ externalProxy: { server: 'http://10.20.30.40', port: 3128 } }] } }));
});

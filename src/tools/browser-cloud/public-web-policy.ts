import { isIP } from 'node:net';
import type { CloudBrowserProfile } from './contract.js';
import { CloudBrowserError } from './contract.js';

/** Trusted runtime pins for the public-web browser. None of these values come from a tool caller. */
export interface TrustedPublicWebPolicy {
  region: string;
  customBrowserIdentifier: string;
  networkPolicyVersion: string;
  privateHostPolicy: string;
  proxyServer: string;
  proxyPort: number;
}

type PublicWebPolicyEnvironment = Record<string, string | undefined>;

const POLICY_ENV = {
  region: 'AWS_REGION',
  browser: 'CLOUD_BROWSER_PUBLIC_WEB_CUSTOM_BROWSER_IDENTIFIER',
  network: 'CLOUD_BROWSER_PUBLIC_WEB_NETWORK_POLICY_VERSION',
  privateHost: 'CLOUD_BROWSER_PUBLIC_WEB_PRIVATE_HOST_POLICY',
  proxyServer: 'CLOUD_BROWSER_PUBLIC_WEB_PROXY_SERVER',
  proxyPort: 'CLOUD_BROWSER_PUBLIC_WEB_PROXY_PORT',
} as const;

function validToken(value: string | undefined, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9._-]+$/.test(value);
}

function validProxyHost(value: string | undefined): value is string {
  if (!value || value.length > 253 || value !== value.trim() || value.includes('://') || value.includes('/') || value.includes('@') || value.includes(':')) return false;
  const hostname = value.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const octets = hostname.split('.').map(Number);
    if (octets[0] === 0 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || octets[0] >= 224) return false;
    return true;
  }
  if (ipVersion === 6) return false;
  if (/^\d+(?:\.\d+){3}$/.test(hostname)) return false;
  return hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/** Missing or malformed trusted configuration disables public_web; legacy mode is unaffected. */
export function parseTrustedPublicWebPolicy(env: PublicWebPolicyEnvironment): TrustedPublicWebPolicy | undefined {
  const region = env[POLICY_ENV.region];
  const browser = env[POLICY_ENV.browser];
  const network = env[POLICY_ENV.network];
  const privateHost = env[POLICY_ENV.privateHost];
  const proxyServer = env[POLICY_ENV.proxyServer];
  const rawPort = env[POLICY_ENV.proxyPort];
  const proxyPort = rawPort && /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!region || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) || !validToken(browser) || !validToken(network) || !validToken(privateHost) || !validProxyHost(proxyServer) || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535) return undefined;
  return { region, customBrowserIdentifier: browser, networkPolicyVersion: network, privateHostPolicy: privateHost, proxyServer, proxyPort };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

/** Throws unless persisted public profile metadata exactly matches trusted runtime pins. */
export function assertTrustedPublicWebProfile(profile: CloudBrowserProfile, policy: TrustedPublicWebPolicy | undefined, runtimeRegion?: string): void {
  if (!policy || (runtimeRegion !== undefined && runtimeRegion !== policy.region) ||
      profile.customBrowserIdentifier !== policy.customBrowserIdentifier ||
      profile.networkPolicyVersion !== policy.networkPolicyVersion ||
      profile.privateHostPolicy !== policy.privateHostPolicy || profile.allowedHosts.length !== 0) {
    throw new CloudBrowserError('public_network_policy_unverified', 'Public browser policy does not match the trusted runtime configuration.');
  }
  const config = profile.proxyConfiguration;
  if (!isRecord(config) || !hasExactKeys(config, ['proxies']) || !Array.isArray(config.proxies) || config.proxies.length !== 1) {
    throw new CloudBrowserError('public_network_policy_unverified', 'Public browser proxy does not match the trusted runtime configuration.');
  }
  const proxy = config.proxies[0];
  if (!isRecord(proxy) || !hasExactKeys(proxy, ['externalProxy']) || !isRecord(proxy.externalProxy) || !hasExactKeys(proxy.externalProxy, ['server', 'port']) ||
      proxy.externalProxy.server !== policy.proxyServer || proxy.externalProxy.port !== policy.proxyPort) {
    throw new CloudBrowserError('public_network_policy_unverified', 'Public browser proxy does not match the trusted runtime configuration.');
  }
}

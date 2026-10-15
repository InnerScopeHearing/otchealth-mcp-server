import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { CloudBrowserError } from './contract.js';

/** Only a non-secret destination is stored. Never supply an OAuth callback or a signed URL. */
export interface WebsiteLoginTargetInput {
  url: string;
  /** Additional exact public DNS hosts needed by this site, for example an SSO provider. */
  allowed_hosts?: readonly string[];
}

/** Canonical immutable policy bound into the single-use login ticket and profile identity. */
export interface WebsiteLoginTarget {
  readonly origin: string;
  readonly expectedPathname: string;
  readonly allowedHosts: readonly string[];
  readonly siteKey: string;
}

export interface WebsiteLoginPolicyDependencies {
  /** Trusted runtime/test injection; never expose resolver or timeout through caller input. */
  lookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  dnsTimeoutMs?: number;
}

const MAX_HOSTS = 24;
const MAX_URL_LENGTH = 2048;
const MAX_PATH_LENGTH = 1024;
const HASH = /^[a-f0-9]{64}$/;
const privateIpv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) privateIpv4.addSubnet(network, prefix, 'ipv4');
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');
const specialIpv6 = new BlockList();
// Special-purpose assignments, documentation, and IPv4 tunnelling are not public web destinations.
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  specialIpv6.addSubnet(network, prefix, 'ipv6');
}

function invalid(): never {
  throw new CloudBrowserError('website_target_invalid', 'Use a non-secret public HTTPS website URL and exact public DNS hosts.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hostname(value: unknown): string {
  if (typeof value !== 'string' || value.length > 253 || value !== value.trim()) return invalid();
  const host = value.toLowerCase();
  if (isIP(host) || !host.includes('.') || !/[a-z]/.test(host.split('.').at(-1) ?? '') ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /(?:^|\.)(?:localhost|localdomain|local|internal|lan|home|corp|invalid|test|example|onion|arpa)$/.test(host)) return invalid();
  return host;
}

function destination(value: unknown): URL {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) return invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      value.includes('?') || value.includes('#') || url.pathname.length > MAX_PATH_LENGTH || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname)) return invalid();
  hostname(url.hostname);
  return url;
}

function immutableTarget(origin: string, expectedPathname: string, allowedHosts: readonly string[]): WebsiteLoginTarget {
  const hosts = Object.freeze([...allowedHosts]);
  const siteKey = createHash('sha256').update(JSON.stringify([origin, expectedPathname, hosts])).digest('hex');
  return Object.freeze({ origin, expectedPathname, allowedHosts: hosts, siteKey });
}

function parseTarget(input: WebsiteLoginTargetInput): WebsiteLoginTarget {
  if (!isRecord(input) || Object.keys(input).some(key => key !== 'url' && key !== 'allowed_hosts')) return invalid();
  const url = destination(input.url);
  if (input.allowed_hosts !== undefined && (!Array.isArray(input.allowed_hosts) || input.allowed_hosts.length > MAX_HOSTS)) return invalid();
  const allowedHosts = [...new Set([url.hostname, ...(input.allowed_hosts ?? []).map(hostname)])].sort();
  if (allowedHosts.length > MAX_HOSTS) return invalid();
  return immutableTarget(url.origin, url.pathname, allowedHosts);
}

/** Synchronous durable-read validation recomputes the policy identity and rejects extra fields. */
export function validateWebsiteLoginTarget(value: unknown): WebsiteLoginTarget {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'allowedHosts,expectedPathname,origin,siteKey' ||
      typeof value.origin !== 'string' || typeof value.expectedPathname !== 'string' || typeof value.siteKey !== 'string' ||
      !HASH.test(value.siteKey) || !Array.isArray(value.allowedHosts) || !value.expectedPathname.startsWith('/')) return invalid();
  const target = parseTarget({ url: `${value.origin}${value.expectedPathname}`, allowed_hosts: value.allowedHosts });
  const storedHosts = value.allowedHosts;
  if (target.origin !== value.origin || target.expectedPathname !== value.expectedPathname || target.siteKey !== value.siteKey ||
      target.allowedHosts.length !== storedHosts.length || target.allowedHosts.some((host, index) => host !== storedHosts[index])) return invalid();
  return target;
}

function publicAddress(address: string, family: number): boolean {
  const version = isIP(address);
  if (version !== family) return false;
  if (version === 4) return !privateIpv4.check(address, 'ipv4');
  // Restrict IPv6 to global unicast. This also excludes mapped/compatible IPv4 and metadata ULA.
  return version === 6 && globalIpv6.check(address, 'ipv6') && !specialIpv6.check(address, 'ipv6');
}

/**
 * This is a DNS preflight, not network pinning. Native aws.browser.v1 does not inherit the
 * public_web custom browser's trusted proxy: subresources and rebinding need provider egress controls.
 */
export async function assertWebsiteLoginTargetPublic(target: WebsiteLoginTarget, dependencies: WebsiteLoginPolicyDependencies = {}): Promise<void> {
  const checked = validateWebsiteLoginTarget(target);
  const resolver = dependencies.lookup ?? (host => lookup(host, { all: true, verbatim: true }));
  // Some deployed/VPC resolvers take a five-second retry even for ordinary public sites.
  const timeoutMs = dependencies.dnsTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return invalid();
  await Promise.all(checked.allowedHosts.map(async host => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const records = await Promise.race([
        resolver(host),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('dns_timeout')), timeoutMs); }),
      ]);
      if (!Array.isArray(records) || records.length === 0 || records.length > 64 || !records.every(record =>
        record && typeof record.address === 'string' && publicAddress(record.address, record.family))) throw new Error('non_public_dns');
    } catch {
      throw new CloudBrowserError('website_target_not_public', 'The website host could not be verified as a public internet destination.');
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }));
}

export async function resolveWebsiteLoginTarget(input: WebsiteLoginTargetInput, dependencies: WebsiteLoginPolicyDependencies = {}): Promise<WebsiteLoginTarget> {
  const target = parseTarget(input);
  await assertWebsiteLoginTargetPublic(target, dependencies);
  return target;
}

/** A URL match is only a destination check; owner Done confirmation is still required. */
export function matchesWebsiteLoginTarget(rawUrl: unknown, target: WebsiteLoginTarget): boolean {
  try {
    const checked = validateWebsiteLoginTarget(target);
    if (typeof rawUrl !== 'string' || rawUrl.length > 16_384 || rawUrl !== rawUrl.trim() || /[\u0000-\u0020\u007f\\]/.test(rawUrl)) return false;
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      url.origin === checked.origin && url.pathname === checked.expectedPathname;
  } catch { return false; }
}

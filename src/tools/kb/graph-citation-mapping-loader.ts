import { createHash } from 'node:crypto';
import type { AwsCredentials } from '../../search/sigv4.js';

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_MAPPING_COUNT = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^sha256:[a-f0-9]{64}$/;
const OBJECT_VERSION = /^[^\s]{1,1024}$/;
const GROUPS = new Set(['company', 'company_shared']);
const KEYS = ['canonical_id', 'provenance_receipt_sha256', 'source_group', 'source_locator_sha256', 'source_sha256', 'source_version'];

export type CitationMappingArtifactConfig = Readonly<{
  // Runtime variables: BEDROCK_GRAPH_CITATION_RECEIPTS_S3_{BUCKET,KEY,VERSION_ID,SHA256}.
  // The task role must allow s3:GetObjectVersion for this exact key. No IAM policy is changed here.
  bucket: string;
  key: string;
  versionId: string;
  sha256: string;
}>;

type CachedArtifact = { cacheKey: string; expiresAt: number; mappings: readonly unknown[] };
let verifiedCache: CachedArtifact | undefined;

function validConfig(config: CitationMappingArtifactConfig): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) &&
    config.key.length > 0 && config.key.length <= 1024 && !config.key.startsWith('/') &&
    config.key.split('/').every((segment) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) && segment !== '.' && segment !== '..') &&
    OBJECT_VERSION.test(config.versionId) && config.versionId !== 'null' && HASH.test(config.sha256);
}

function validMapping(value: unknown): value is Record<string, unknown> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const mapping = value as Record<string, unknown>;
  return Object.keys(mapping).sort().join('\0') === [...KEYS].sort().join('\0') &&
    typeof mapping.canonical_id === 'string' && HASH.test(mapping.canonical_id) &&
    typeof mapping.source_version === 'string' && VERSION.test(mapping.source_version) &&
    typeof mapping.source_group === 'string' && GROUPS.has(mapping.source_group) &&
    typeof mapping.source_sha256 === 'string' && HASH.test(mapping.source_sha256) &&
    mapping.source_version === `sha256:${mapping.source_sha256}` &&
    typeof mapping.source_locator_sha256 === 'string' && HASH.test(mapping.source_locator_sha256) &&
    typeof mapping.provenance_receipt_sha256 === 'string' && HASH.test(mapping.provenance_receipt_sha256);
}

async function readBounded(response: Response): Promise<Buffer | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_ARTIFACT_BYTES)) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARTIFACT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetches an immutable mapping artifact by exact S3 object version and verifies its raw bytes
 * against the deployment-pinned SHA-256 before returning or caching any mapping.
 * Failures deliberately collapse to an empty set so callers emit unresolved citation receipts.
 */
export async function loadGraphCitationMappings(
  config: CitationMappingArtifactConfig | undefined,
  credentials: AwsCredentials | null,
  fetchImpl: typeof fetch,
  sign: (opts: { method: string; host: string; path: string; query: string; region: string; service: string; credentials: AwsCredentials }) => { headers: Record<string, string> },
): Promise<readonly unknown[]> {
  if (!config || !credentials || !validConfig(config)) return [];
  const cacheKey = JSON.stringify([config.bucket, config.key, config.versionId, config.sha256]);
  if (verifiedCache?.cacheKey === cacheKey && verifiedCache.expiresAt > Date.now()) return verifiedCache.mappings;

  try {
    const host = `${config.bucket}.s3.us-east-1.amazonaws.com`;
    const path = `/${config.key.split('/').map(encodeURIComponent).join('/')}`;
    const query = `versionId=${encodeURIComponent(config.versionId)}`;
    const signed = sign({ method: 'GET', host, path, query, region: 'us-east-1', service: 's3', credentials });
    const response = await fetchImpl(`https://${host}${path}?${query}`, {
      method: 'GET', headers: signed.headers, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || response.headers.get('x-amz-version-id') !== config.versionId) {
      await response.body?.cancel().catch(() => undefined);
      return [];
    }
    const bytes = await readBounded(response);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== config.sha256) return [];
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return [];
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length > MAX_MAPPING_COUNT || !parsed.every(validMapping)) return [];
    const seen = new Set<string>();
    for (const mapping of parsed) {
      const key = `${mapping.canonical_id}\0${mapping.source_version}`;
      if (seen.has(key)) return [];
      seen.add(key);
    }
    const mappings = Object.freeze(parsed.map((mapping) => Object.freeze(mapping)));
    verifiedCache = { cacheKey, expiresAt: Date.now() + CACHE_TTL_MS, mappings };
    return mappings;
  } catch {
    return [];
  }
}

export function clearGraphCitationMappingCacheForTests(): void {
  verifiedCache = undefined;
}

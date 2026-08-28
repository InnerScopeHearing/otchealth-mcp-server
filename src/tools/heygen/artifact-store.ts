/**
 * HeyGen production-control artifact store — downloaded video/thumbnail/gif/subtitle assets and QA
 * manifests from ingestHeyGenVideoArtifacts (artifact-qa.ts), private, never public.
 *
 * BACKEND (2026-08-28): mirrors the BLOB_BACKEND switch every other document store in this repo
 * honours (see legal/blob-store.ts). Was Azure-ONLY -- a hand-rolled account-SAS writer against
 * AZURE_COMMONS_STORAGE_ACCOUNT/KEY, with no branch of any kind -- which is now a PERMANENTLY DEAD
 * path (Azure subscription 55c84f6b deleted 2026-08-13); any write attempted against it fails. Under
 * BLOB_BACKEND=s3 this now routes through s3-blob-store.ts's putObjectToS3, via a MIRROR row keyed
 * `otchealthcommons/heygen-artifacts` -> the same commons DR bucket the shared exec brain already
 * writes to (no new IAM grant needed).
 *
 * This is a STORAGE-ROUTING change only. It does not touch, and must never be read as touching, any
 * of the ENABLE_HEYGEN_*_WRITES feature flags or HEYGEN_APPROVAL_BROKER_URL -- those remain exactly
 * as configured (a separate, Matt-approval-gated decision; see production-tools.ts and health.ts).
 * `heygen_video_wait_ingest_qa` (the sole caller of .put()) persists QA artifacts for an ALREADY
 * accepted/completed operation -- it does not itself create new spend, and is reachable independently
 * of whether the owner-approval broker (which gates NEW video generation) is up.
 */
import crypto from 'node:crypto';
import { loadEnv } from '../../config/env.js';
import { s3BlobBackendActive, putObjectToS3 } from '../../legal/s3-blob-store.js';

const CONTAINER = 'heygen-artifacts';
const PREFIX = '_ARTIFACTS/heygen/';
const BLOB_API_VERSION = '2021-12-02';

/**
 * The (account, container) key this store resolves through s3-blob-store.ts's MIRROR table under
 * BLOB_BACKEND=s3. Synthetic (HeyGen artifacts never had a real Azure Storage account row); see that
 * table's own comment on this row for why.
 */
const S3_MIRROR_ACCOUNT = 'otchealthcommons';

export interface HeyGenArtifactStore {
  configured(): boolean;
  put(relativePath: string, body: Uint8Array, contentType: string): Promise<{ artifactUri: string; blobPath: string }>;
}

function credentials(): { account: string; key: string } | null {
  const env = loadEnv();
  if (!env.AZURE_COMMONS_STORAGE_ACCOUNT || !env.AZURE_COMMONS_STORAGE_KEY) return null;
  return { account: env.AZURE_COMMONS_STORAGE_ACCOUNT, key: env.AZURE_COMMONS_STORAGE_KEY };
}

function accountSas(account: string, key: string, permissions = 'cw', hours = 1): string {
  const services = 'b';
  const resourceTypes = 'co';
  const start = `${new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 19)}Z`;
  const expiry = `${new Date(Date.now() + hours * 3_600_000).toISOString().slice(0, 19)}Z`;
  const stringToSign = `${[account, permissions, services, resourceTypes, start, expiry, '', 'https', BLOB_API_VERSION, ''].join('\n')}\n`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(key, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');
  return new URLSearchParams({
    sv: BLOB_API_VERSION,
    ss: services,
    srt: resourceTypes,
    sp: permissions,
    st: start,
    se: expiry,
    spr: 'https',
    sig: signature,
  }).toString();
}

function encodeBlobPath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

export function validateHeyGenArtifactRelativePath(path: string): string {
  if (
    typeof path !== 'string' ||
    path.length < 3 ||
    path.length > 512 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('..') ||
    !/^[A-Za-z0-9_.\-/]+$/.test(path)
  ) {
    throw new Error('HeyGen artifact path is invalid.');
  }
  return path;
}

/**
 * The persisted artifact URI. `account` is only meaningful on the Azure branch (kept as a parameter
 * so an existing caller passing the Azure account is unaffected); under BLOB_BACKEND=s3 the scheme
 * and host are fixed (S3_MIRROR_ACCOUNT), matching how the store actually resolves the object.
 *
 * NO READ PATH EXISTS FOR EITHER SCHEME (verified 2026-08-28: grepping this whole repo for a
 * consumer of `artifactUri`/`manifestUri` finds only artifact-qa.ts passing them through as opaque
 * strings in its return value -- nothing ever parses one back into a store lookup). So there is
 * deliberately no "read-compat shim" for a historical `azure://` URI here: nothing reads one today,
 * and if that ever changes, the shim belongs at the READ call site added at that time, not
 * speculatively here.
 */
export function heyGenArtifactUri(account: string, relativePath: string): string {
  const safe = validateHeyGenArtifactRelativePath(relativePath);
  if (s3BlobBackendActive()) return `s3://${S3_MIRROR_ACCOUNT}/${CONTAINER}/${PREFIX}${safe}`;
  return `azure://${account}/${CONTAINER}/${PREFIX}${safe}`;
}

const containerReady = new Map<string, Promise<void>>();

async function ensurePrivateContainer(account: string, sas: string): Promise<void> {
  const existing = containerReady.get(account);
  if (existing) return existing;
  const pending = (async () => {
    let response: Response;
    try {
      response = await fetch(`https://${account}.blob.core.windows.net/${CONTAINER}?restype=container&${sas}`, {
        method: 'PUT',
        headers: { 'x-ms-version': BLOB_API_VERSION },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('HeyGen artifact container check did not complete.');
    }
    if (response.status !== 201 && response.status !== 409) {
      throw new Error(`HeyGen artifact container check failed (HTTP ${response.status}).`);
    }
  })();
  containerReady.set(account, pending);
  try {
    await pending;
  } catch (error) {
    containerReady.delete(account);
    throw error;
  }
}

export const defaultHeyGenArtifactStore: HeyGenArtifactStore = {
  // Under BLOB_BACKEND=s3, AWS credentials resolve at call time via the ECS task role (see
  // s3-blob-store.ts's writeContext/resolveAwsCredentials) -- there is nothing synchronous to check
  // here, mirroring exactly how blob-store.ts's isConfigured() treats the S3 backend as usable
  // without a static key. The Azure branch is unchanged.
  configured: () => s3BlobBackendActive() || credentials() !== null,
  put: async (relativePath, body, contentType) => {
    const safe = validateHeyGenArtifactRelativePath(relativePath);
    const blobPath = `${PREFIX}${safe}`;
    if (s3BlobBackendActive()) {
      // overwrite:true matches this store's PREVIOUS (and only) Azure behaviour exactly: the Azure
      // PUT below has never sent a conditional header, so every write has always unconditionally
      // overwritten. Manifest paths are NOT content-hash-scoped (unlike the per-asset paths, see
      // artifact-qa.ts) and are re-written verbatim on an ingest retry for the same operation+video,
      // so a fail-closed no-clobber default here would be a regression, not a hardening.
      await putObjectToS3(S3_MIRROR_ACCOUNT, CONTAINER, blobPath, Buffer.from(body), contentType, true);
      return { artifactUri: heyGenArtifactUri(S3_MIRROR_ACCOUNT, safe), blobPath };
    }
    const creds = credentials();
    if (!creds) throw new Error('HeyGen artifact storage is not configured.');
    const sas = accountSas(creds.account, creds.key);
    await ensurePrivateContainer(creds.account, sas);
    const url = `https://${creds.account}.blob.core.windows.net/${CONTAINER}/${encodeBlobPath(blobPath)}?${sas}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: {
          'x-ms-blob-type': 'BlockBlob',
          'Content-Type': contentType,
          'Cache-Control': 'private, no-store',
        },
        body,
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      throw new Error('HeyGen artifact upload did not complete.');
    }
    if (!response.ok) throw new Error(`HeyGen artifact upload failed (HTTP ${response.status}).`);
    return { artifactUri: heyGenArtifactUri(creds.account, safe), blobPath };
  },
};

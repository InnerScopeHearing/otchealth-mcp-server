import crypto from 'node:crypto';
import { loadEnv } from '../../config/env.js';

const CONTAINER = 'heygen-artifacts';
const PREFIX = '_ARTIFACTS/heygen/';
const BLOB_API_VERSION = '2021-12-02';

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

export function heyGenArtifactUri(account: string, relativePath: string): string {
  const safe = validateHeyGenArtifactRelativePath(relativePath);
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
  configured: () => credentials() !== null,
  put: async (relativePath, body, contentType) => {
    const creds = credentials();
    if (!creds) throw new Error('HeyGen artifact storage is not configured.');
    const safe = validateHeyGenArtifactRelativePath(relativePath);
    const blobPath = `${PREFIX}${safe}`;
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

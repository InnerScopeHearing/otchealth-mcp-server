/**
 * Legal document store client — Azure Blob (SharedKey), account otchealthlegalstore,
 * containers `company` and `personal`.
 *
 * HARD separation (mirrors skills/legal/legal.mjs, the CLO's proven local backbone):
 *   company/   = company legal matters + documents.
 *   personal/  = Matt's CONFIDENTIAL personal matters (the CA divorce + civil case). This is the
 *                MOST SENSITIVE corpus in the fleet (attorney-privileged, incl. minors' data). Its
 *                gateway access is ring-gated identically to the `legal-personal` AI-Search index
 *                (see src/tools/legal/ring.ts) — never broader.
 *
 * SharedKey auth. The `azSig` signer below is ported FAITHFULLY from skills/legal/legal.mjs
 * (otchealth-claude-tools, function azSig) — the exact StringToSign construction already used
 * successfully against THIS same storage account. Do not re-derive Azure Blob SharedKey signing;
 * this is a line-for-line port of the proven approach (same 13-field StringToSign, same canonical
 * headers + canonical resource, same HMAC-SHA256 over base64-decoded key, same x-ms-version).
 *
 * Credentials: AZURE_LEGAL_STORAGE_ACCOUNT / AZURE_LEGAL_STORAGE_KEY (hydrated from Key Vault
 * secrets azure-legal-storage-account / azure-legal-storage-key). Inert without the key:
 * isConfigured() is false and the tools return a clear "not configured" result rather than throwing.
 */

import crypto from 'node:crypto';
import { loadEnv } from '../config/env.js';

/** x-ms-version, matching skills/legal/legal.mjs exactly. */
const AVER = '2021-06-08';

export type LegalContainer = 'company' | 'personal';

export interface LegalCreds {
  account: string;
  key: string;
}

function creds(): LegalCreds | null {
  const env = loadEnv();
  const account = env.AZURE_LEGAL_STORAGE_ACCOUNT;
  const key = env.AZURE_LEGAL_STORAGE_KEY;
  if (!account || !key) return null;
  return { account, key };
}

/** True when the SharedKey credentials are present. */
export function isConfigured(): boolean {
  return creds() !== null;
}

/**
 * SharedKey signature — ported verbatim (behaviour-for-behaviour) from skills/legal/legal.mjs `azSig`.
 * StringToSign = VERB \n Content-Encoding \n Content-Language \n Content-Length \n Content-MD5 \n
 *   Content-Type \n Date \n If-Modified-Since \n If-Match \n If-None-Match \n If-Unmodified-Since \n
 *   Range \n CanonicalizedHeaders + CanonicalizedResource.
 *
 * ifNoneMatch MUST be passed whenever the actual outgoing request carries an If-None-Match header
 * (e.g. putBlob's no-silent-overwrite guard sends "If-None-Match: *") — Azure validates the
 * signature against the REAL header values it received, so an empty string here while a real
 * header is sent produces AuthenticationFailed (this was a live bug: put failed 403 while
 * get/list, which never send this header, worked fine).
 */
export function azSig(
  account: string,
  key: string,
  method: string,
  container: string,
  blob: string,
  xms: Record<string, string>,
  query: Record<string, string> | null,
  contentLength: string,
  contentType: string,
  ifNoneMatch = '',
): string {
  const canonHeaders =
    Object.keys(xms)
      .sort()
      .map((k) => `${k.toLowerCase()}:${xms[k]}`)
      .join('\n') + '\n';
  let canonResource = `/${account}/${container}` + (blob ? `/${blob}` : '');
  if (query) for (const k of Object.keys(query).sort()) canonResource += `\n${k.toLowerCase()}:${query[k]}`;
  const sts = [
    method,
    '', // Content-Encoding
    '', // Content-Language
    contentLength || '', // Content-Length
    '', // Content-MD5
    contentType || '', // Content-Type
    '', // Date (using x-ms-date header instead)
    '', // If-Modified-Since
    '', // If-Match
    ifNoneMatch || '', // If-None-Match
    '', // If-Unmodified-Since
    '', // Range
    canonHeaders + canonResource,
  ].join('\n');
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(sts, 'utf8').digest('base64');
  return `SharedKey ${account}:${sig}`;
}

/** Percent-encode each path segment (blob names may contain slashes as virtual folders). */
function encPath(name: string): string {
  return name
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

export interface BlobListItem {
  name: string;
  size: number | null;
  lastModified: string | null;
  contentType: string | null;
}

/**
 * List blobs in a container under an optional prefix. Read-only.
 * Uses the Blob "List Blobs" REST op (restype=container&comp=list) — the same call shape as
 * legal.mjs listMatterNames, generalized to an arbitrary prefix.
 */
export async function listBlobs(container: LegalContainer, prefix?: string): Promise<BlobListItem[]> {
  const c = creds();
  if (!c) throw new Error('legal store not configured (AZURE_LEGAL_STORAGE_KEY unset)');
  const xms = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': AVER };
  const query: Record<string, string> = { comp: 'list', restype: 'container' };
  if (prefix) query.prefix = prefix;
  const auth = azSig(c.account, c.key, 'GET', container, '', xms, query, '', '');
  let url = `https://${c.account}.blob.core.windows.net/${container}?restype=container&comp=list`;
  if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`;
  const r = await fetch(url, { headers: { ...xms, Authorization: auth } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`legal blob list ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const xml = await r.text();
  const items: BlobListItem[] = [];
  // Parse each <Blob>…</Blob> block: <Name>, <Content-Length>, <Last-Modified>, <Content-Type>.
  for (const block of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
    const b = block[1];
    const name = (b.match(/<Name>([^<]+)<\/Name>/) || [])[1];
    if (!name) continue;
    const sizeStr = (b.match(/<Content-Length>([^<]*)<\/Content-Length>/) || [])[1];
    items.push({
      name,
      size: sizeStr ? Number.parseInt(sizeStr, 10) : null,
      lastModified: (b.match(/<Last-Modified>([^<]+)<\/Last-Modified>/) || [])[1] || null,
      contentType: (b.match(/<Content-Type>([^<]*)<\/Content-Type>/) || [])[1] || null,
    });
  }
  return items;
}

export interface BlobGetResult {
  found: boolean;
  contentType: string | null;
  size: number | null;
  /** UTF-8 text when the blob is textual; null when returned as base64 instead. */
  text: string | null;
  /** base64 payload when the blob is binary (or when caller forces base64). */
  base64: string | null;
}

/** Heuristic: treat these content types (or a missing type + valid UTF-8) as text. */
function looksTextual(contentType: string | null): boolean {
  if (!contentType) return false;
  return /^(text\/|application\/(json|xml|x-ndjson|javascript|x-www-form-urlencoded)|application\/.*\+(json|xml))/i.test(
    contentType,
  );
}

/**
 * Fetch a blob's content by container + path. Read-only.
 * Returns text for textual content types, otherwise base64 (binary-safe). `forceBase64` always
 * returns base64. 404 -> { found: false }.
 */
export async function getBlob(
  container: LegalContainer,
  path: string,
  forceBase64 = false,
): Promise<BlobGetResult> {
  const c = creds();
  if (!c) throw new Error('legal store not configured (AZURE_LEGAL_STORAGE_KEY unset)');
  const xms = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': AVER };
  const auth = azSig(c.account, c.key, 'GET', container, encPath(path), xms, null, '', '');
  const r = await fetch(`https://${c.account}.blob.core.windows.net/${container}/${encPath(path)}`, {
    headers: { ...xms, Authorization: auth },
  });
  if (r.status === 404) return { found: false, contentType: null, size: null, text: null, base64: null };
  if (!r.ok) throw new Error(`legal blob get ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const contentType = r.headers.get('content-type');
  const buf = Buffer.from(await r.arrayBuffer());
  if (!forceBase64 && looksTextual(contentType)) {
    return { found: true, contentType, size: buf.length, text: buf.toString('utf8'), base64: null };
  }
  return { found: true, contentType, size: buf.length, text: null, base64: buf.toString('base64') };
}

/** HEAD a blob to test existence without downloading it (fail-closed overwrite check). */
export async function blobExists(container: LegalContainer, path: string): Promise<boolean> {
  const c = creds();
  if (!c) throw new Error('legal store not configured (AZURE_LEGAL_STORAGE_KEY unset)');
  const xms = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': AVER };
  const auth = azSig(c.account, c.key, 'HEAD', container, encPath(path), xms, null, '', '');
  const r = await fetch(`https://${c.account}.blob.core.windows.net/${container}/${encPath(path)}`, {
    method: 'HEAD',
    headers: { ...xms, Authorization: auth },
  });
  if (r.status === 404) return false;
  if (r.status === 200) return true;
  throw new Error(`legal blob head ${r.status}`);
}

export interface BlobPutResult {
  path: string;
  container: LegalContainer;
  bytes: number;
  contentType: string;
}

/**
 * Upload a blob (BlockBlob). Binary-safe: pass either `text` or `base64`.
 *
 * Callers MUST pre-check existence when overwrite is not intended (the tool layer enforces the
 * fail-closed no-silent-clobber default). This function additionally sends the If-None-Match: *
 * conditional header when overwrite=false so a race that creates the blob between the existence
 * check and the PUT is still refused server-side (412) — belt and suspenders for filed court
 * documents.
 *
 * BUGFIX (2026-07-06): the If-None-Match: * header sent below was previously NOT reflected in the
 * SharedKey signature (azSig always signed an empty If-None-Match field), so every put without
 * overwrite=true failed 403 AuthenticationFailed even with a fully correct key — Azure signs
 * against what was ACTUALLY sent. Now threaded through to azSig so the signature matches the
 * real request.
 */
export async function putBlob(
  container: LegalContainer,
  path: string,
  body: { text?: string; base64?: string; contentType?: string },
  overwrite = false,
): Promise<BlobPutResult> {
  const c = creds();
  if (!c) throw new Error('legal store not configured (AZURE_LEGAL_STORAGE_KEY unset)');
  const buf =
    body.base64 != null ? Buffer.from(body.base64, 'base64') : Buffer.from(body.text ?? '', 'utf8');
  const ct = body.contentType || (body.base64 != null ? 'application/octet-stream' : 'application/json');
  const xms: Record<string, string> = {
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-date': new Date().toUTCString(),
    'x-ms-version': AVER,
  };
  const ifNoneMatch = overwrite ? '' : '*';
  const auth = azSig(c.account, c.key, 'PUT', container, encPath(path), xms, null, String(buf.length), ct, ifNoneMatch);
  const headers: Record<string, string> = { ...xms, 'Content-Type': ct, Authorization: auth };
  // Server-side guard against a TOCTOU clobber: reject if the blob already exists.
  if (!overwrite) headers['If-None-Match'] = ifNoneMatch;
  const r = await fetch(`https://${c.account}.blob.core.windows.net/${container}/${encPath(path)}`, {
    method: 'PUT',
    headers,
    body: buf,
  });
  if (r.status === 409 || r.status === 412) {
    throw new Error(
      `legal blob put refused: a blob already exists at ${container}/${path} (HTTP ${r.status}). ` +
        `Pass overwrite=true to intentionally replace it.`,
    );
  }
  if (!r.ok) throw new Error(`legal blob put ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return { path, container, bytes: buf.length, contentType: ct };
}

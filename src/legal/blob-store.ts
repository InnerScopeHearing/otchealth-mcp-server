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
  ifMatch = '',
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
    ifMatch || '', // If-Match
    ifNoneMatch || '', // If-None-Match
    '', // If-Unmodified-Since
    '', // Range
    canonHeaders + canonResource,
  ].join('\n');
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(sts, 'utf8').digest('base64');
  return `SharedKey ${account}:${sig}`;
}

/**
 * Decode the small set of XML entities Azure's List Blobs response can contain in a <Name> (or
 * other text node) — a real blob like "Motion & Order.pdf" comes back as "Motion &amp; Order.pdf"
 * (2026-08-04, PR #190 review: an undecoded name sent back to Azure on a subsequent mutation
 * targets a DIFFERENT, nonexistent blob and fails mid-batch). `&amp;` is decoded LAST so a literal
 * escaped entity in the source text (e.g. "&amp;lt;") is never double-unescaped into "<".
 */
function xmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&amp;/g, '&');
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
  /** The blob's current ETag, when Azure returns one on the list op — used by bulk callers (e.g.
   *  legal_blob_delete) to pin a subsequent copy/delete to this exact version without a second HEAD
   *  per item. Null on a listing error edge case, never on a normal successful list. */
  etag: string | null;
}

/**
 * List blobs in a container under an optional prefix. Read-only.
 * Uses the Blob "List Blobs" REST op (restype=container&comp=list) — the same call shape as
 * legal.mjs listMatterNames, generalized to an arbitrary prefix.
 *
 * PAGINATED TO EXHAUSTION (2026-08-04, PR #190 review): Azure can return a partial page and a
 * <NextMarker> for a large or busy container. A caller like legal_blob_delete's bulk mode enforces
 * max_items against the FULL matched set and must never mistake one truncated page for the whole
 * result -- that would let it silently under-count and mutate an incomplete slice. Bounded at 200
 * pages (Azure's default page size is up to 5000 blobs/page, so this comfortably covers any
 * realistic legal-document container) as a backstop against an infinite loop on a malformed/looping
 * marker, never expected to bind in practice.
 */
export async function listBlobs(container: LegalContainer, prefix?: string): Promise<BlobListItem[]> {
  const c = creds();
  if (!c) throw new Error('legal store not configured (AZURE_LEGAL_STORAGE_KEY unset)');
  const items: BlobListItem[] = [];
  let marker: string | undefined;
  for (let page = 0; page < 200; page++) {
    const xms = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': AVER };
    const query: Record<string, string> = { comp: 'list', restype: 'container' };
    if (prefix) query.prefix = prefix;
    if (marker) query.marker = marker;
    const auth = azSig(c.account, c.key, 'GET', container, '', xms, query, '', '');
    let url = `https://${c.account}.blob.core.windows.net/${container}?restype=container&comp=list`;
    if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`;
    if (marker) url += `&marker=${encodeURIComponent(marker)}`;
    const r = await fetch(url, { headers: { ...xms, Authorization: auth } });
    if (r.status === 404) break;
    if (!r.ok) throw new Error(`legal blob list ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const xml = await r.text();
    // Parse each <Blob>…</Blob> block: <Name>, <Content-Length>, <Last-Modified>, <Content-Type>, <Etag>.
    for (const block of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
      const b = block[1];
      const name = (b.match(/<Name>([^<]+)<\/Name>/) || [])[1];
      if (!name) continue;
      const sizeStr = (b.match(/<Content-Length>([^<]*)<\/Content-Length>/) || [])[1];
      items.push({
        name: xmlDecode(name),
        size: sizeStr ? Number.parseInt(sizeStr, 10) : null,
        lastModified: (b.match(/<Last-Modified>([^<]+)<\/Last-Modified>/) || [])[1] || null,
        contentType: (b.match(/<Content-Type>([^<]*)<\/Content-Type>/) || [])[1] || null,
        etag: (b.match(/<Etag>([^<]*)<\/Etag>/) || [])[1] || null,
      });
    }
    const nextMarker = (xml.match(/<NextMarker>([^<]*)<\/NextMarker>/) || [])[1] || '';
    if (!nextMarker) break;
    marker = nextMarker;
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
/**
 * Generic SharedKey blob GET against ANY account/container, using the same proven signer.
 * Exists so other ring-gated stores (the finance dataroom behind kb_get_document) reuse the
 * exact azSig construction instead of re-deriving Azure SharedKey signing (the known footgun this
 * file's header warns about). Returns raw bytes; the caller decides text vs base64 handling.
 */
export async function fetchBlobRaw(
  account: string,
  key: string,
  container: string,
  path: string,
): Promise<{ found: boolean; contentType: string | null; buf: Buffer | null }> {
  const xms = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': AVER };
  const auth = azSig(account, key, 'GET', container, encPath(path), xms, null, '', '');
  const r = await fetch(`https://${account}.blob.core.windows.net/${container}/${encPath(path)}`, {
    headers: { ...xms, Authorization: auth },
  });
  if (r.status === 404) return { found: false, contentType: null, buf: null };
  if (!r.ok) throw new Error(`blob get ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return { found: true, contentType: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) };
}

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

export interface BlobHeadResult {
  exists: boolean;
  /** Current ETag, when the blob exists — the version-pinning token for a subsequent conditional
   *  copy (x-ms-source-if-match) or delete (If-Match), see copyBlob/deleteBlobHard below. */
  etag: string | null;
  size: number | null;
}

/**
 * HEAD a blob: existence + ETag + size in one call. The ETag is what lets a copy-then-delete
 * caller (legal_blob_move, legal_blob_delete) pin BOTH the copy and the delete to the exact source
 * version this HEAD observed, so a concurrent overwrite of the source between "check" and "act"
 * fails the operation closed instead of silently deleting a different version than was copied
 * (2026-08-04, PR #190 review — the original copy-then-delete had no such guard at all).
 */
export async function headBlob(container: LegalContainer, path: string): Promise<BlobHeadResult> {
  const c = creds();
  if (!c) throw new Error('legal store not configured (AZURE_LEGAL_STORAGE_KEY unset)');
  const xms = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': AVER };
  const auth = azSig(c.account, c.key, 'HEAD', container, encPath(path), xms, null, '', '');
  const r = await fetch(`https://${c.account}.blob.core.windows.net/${container}/${encPath(path)}`, {
    method: 'HEAD',
    headers: { ...xms, Authorization: auth },
  });
  if (r.status === 404) return { exists: false, etag: null, size: null };
  if (r.status !== 200) throw new Error(`legal blob head ${r.status}`);
  const cl = r.headers.get('content-length');
  return { exists: true, etag: r.headers.get('etag'), size: cl ? Number.parseInt(cl, 10) : null };
}

/** HEAD a blob to test existence without downloading it (fail-closed overwrite check). Thin
 *  boolean wrapper over headBlob for callers that only need existence, not the ETag. */
export async function blobExists(container: LegalContainer, path: string): Promise<boolean> {
  return (await headBlob(container, path)).exists;
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

/**
 * Server-side Copy Blob (2026-08-04, CLO brief §1 — the store had create + overwrite but no way to
 * move, copy, rename, or delete a blob at all). Azure Blob has no native rename/move op; both are
 * built from this copy primitive + deleteBlobHard below (copy-verify-then-delete-original).
 *
 * Same-account, same-key copy: the destination PUT carries `x-ms-copy-source` (the source blob's
 * full URL) and Azure reads the source using the SAME SharedKey principal making the request — no
 * separate source auth needed. Azure Copy Blob can be asynchronous for large blobs; this polls
 * `x-ms-copy-status` via HEAD on the destination (bounded, since these are legal documents in the
 * KB range, not multi-GB files) rather than assuming synchronous completion.
 */
export async function copyBlob(
  container: LegalContainer,
  srcPath: string,
  dstPath: string,
  overwrite = false,
  srcEtag?: string,
): Promise<{ bytes: number; copyStatus: string }> {
  const c = creds();
  if (!c) throw new Error('legal store not configured (AZURE_LEGAL_STORAGE_KEY unset)');
  const sourceUrl = `https://${c.account}.blob.core.windows.net/${container}/${encPath(srcPath)}`;
  const xms: Record<string, string> = {
    'x-ms-copy-source': sourceUrl,
    'x-ms-date': new Date().toUTCString(),
    'x-ms-version': AVER,
  };
  // Pin the copy to the exact source version the caller observed (via headBlob/listBlobs) just
  // before calling this: if another writer overwrites the source between that observation and this
  // PUT, Azure itself refuses the copy (412) instead of silently copying a different version. See
  // the matching If-Match guard on deleteBlobHard below -- together they close the copy-then-delete
  // TOCTOU window a caller-supplied srcEtag protects (2026-08-04, PR #190 review).
  if (srcEtag) xms['x-ms-source-if-match'] = srcEtag;
  const ifNoneMatch = overwrite ? '' : '*';
  const auth = azSig(c.account, c.key, 'PUT', container, encPath(dstPath), xms, null, '', '', ifNoneMatch);
  const headers: Record<string, string> = { ...xms, Authorization: auth };
  if (!overwrite) headers['If-None-Match'] = ifNoneMatch;
  const r = await fetch(`https://${c.account}.blob.core.windows.net/${container}/${encPath(dstPath)}`, {
    method: 'PUT',
    headers,
  });
  if (r.status === 404) {
    throw new Error(`legal blob copy: source ${container}/${srcPath} not found.`);
  }
  if (r.status === 409 || r.status === 412) {
    throw new Error(
      `legal blob copy refused (HTTP ${r.status}): either a blob already exists at ${container}/${dstPath} ` +
        `(pass overwrite=true to replace it), or the source at ${container}/${srcPath} changed since it was ` +
        `last checked and no longer matches the expected version. Re-check and retry.`,
    );
  }
  if (!r.ok) throw new Error(`legal blob copy ${r.status}: ${(await r.text()).slice(0, 200)}`);
  let copyStatus = r.headers.get('x-ms-copy-status') || 'success';

  // Bounded poll if Azure started an async copy (rare for small legal documents, but handle it).
  const deadline = Date.now() + 20_000;
  while (copyStatus === 'pending' && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 500));
    const hxms = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': AVER };
    const hauth = azSig(c.account, c.key, 'HEAD', container, encPath(dstPath), hxms, null, '', '');
    const hr = await fetch(`https://${c.account}.blob.core.windows.net/${container}/${encPath(dstPath)}`, {
      method: 'HEAD',
      headers: { ...hxms, Authorization: hauth },
    });
    copyStatus = hr.headers.get('x-ms-copy-status') || copyStatus;
  }
  if (copyStatus === 'pending') {
    throw new Error(`legal blob copy did not complete (status=pending) within 20s for ${container}/${dstPath}.`);
  }
  if (copyStatus !== 'success') {
    throw new Error(`legal blob copy failed to complete (status=${copyStatus}) for ${container}/${dstPath}.`);
  }

  // Content-Length on the Copy Blob PUT response is the HTTP RESPONSE-BODY length (normally 0,
  // since a successful PUT returns no body) -- NOT the copied blob's size. A final HEAD on the
  // destination is the only reliable way to report real bytes (2026-08-04, PR #190 review: every
  // caller was previously reporting bytes:0 on every real copy).
  const fxms = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': AVER };
  const fauth = azSig(c.account, c.key, 'HEAD', container, encPath(dstPath), fxms, null, '', '');
  const fr = await fetch(`https://${c.account}.blob.core.windows.net/${container}/${encPath(dstPath)}`, {
    method: 'HEAD',
    headers: { ...fxms, Authorization: fauth },
  });
  const sizeHeader = fr.ok ? fr.headers.get('content-length') : null;
  return { bytes: sizeHeader ? Number.parseInt(sizeHeader, 10) : 0, copyStatus };
}

/**
 * Hard DELETE of a blob. LOW-LEVEL primitive only — never call this directly from a tool handler
 * for a caller-initiated delete. The tool layer (legal-blob-delete.ts) always copies to
 * `_TRASH/<original-path>` FIRST and verifies the copy landed before calling this to remove the
 * original, so a caller-facing "delete" is a soft, recoverable move, never a direct hard delete of
 * the only copy. This primitive exists so that move-to-trash flow (and legal_blob_move, which is
 * copy-then-remove-original between two arbitrary paths) has something to call once the copy is
 * verified.
 */
export async function deleteBlobHard(container: LegalContainer, path: string, ifMatch?: string): Promise<void> {
  const c = creds();
  if (!c) throw new Error('legal store not configured (AZURE_LEGAL_STORAGE_KEY unset)');
  const xms = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': AVER };
  const auth = azSig(c.account, c.key, 'DELETE', container, encPath(path), xms, null, '', '', '', ifMatch || '');
  const headers: Record<string, string> = { ...xms, Authorization: auth };
  // Pins the delete to the exact version that was just copied (see copyBlob's matching
  // x-ms-source-if-match): if the source changed after the copy but before this DELETE, Azure
  // refuses (412) instead of deleting a version that was never actually copied to safety.
  if (ifMatch) headers['If-Match'] = ifMatch;
  const r = await fetch(`https://${c.account}.blob.core.windows.net/${container}/${encPath(path)}`, {
    method: 'DELETE',
    headers,
  });
  if (r.status === 404) return; // already gone; treat as success (idempotent)
  if (r.status === 412) {
    throw new Error(
      `legal blob delete refused: the blob at ${container}/${path} changed since it was copied (ETag no ` +
        `longer matches what was just moved to safety). Nothing was deleted; investigate and retry.`,
    );
  }
  if (!r.ok) throw new Error(`legal blob delete ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export interface BlobPutRawResult {
  path: string;
  container: string;
  bytes: number;
  contentType: string;
}

/**
 * Generic SharedKey blob PUT against ANY account/container (2026-07-25, added for
 * mail_archive_save_attachment_to_dataroom) — the write-side counterpart to fetchBlobRaw above.
 * Same reasoning: reuse the proven azSig construction rather than re-deriving Azure SharedKey
 * signing for a second store. Binary-safe (pass base64 or text). Same fail-closed
 * no-silent-clobber default as putBlob, and the same BUGFIX documented above putBlob (If-None-Match
 * must be threaded into azSig, not just sent on the wire, or the signature won't match what Azure
 * actually received and every non-overwrite PUT 403s).
 */
export async function putBlobRaw(
  account: string,
  key: string,
  container: string,
  path: string,
  body: { text?: string; base64?: string; contentType?: string },
  overwrite = false,
): Promise<BlobPutRawResult> {
  const buf = body.base64 != null ? Buffer.from(body.base64, 'base64') : Buffer.from(body.text ?? '', 'utf8');
  const ct = body.contentType || (body.base64 != null ? 'application/octet-stream' : 'application/json');
  const xms: Record<string, string> = {
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-date': new Date().toUTCString(),
    'x-ms-version': AVER,
  };
  const ifNoneMatch = overwrite ? '' : '*';
  const auth = azSig(account, key, 'PUT', container, encPath(path), xms, null, String(buf.length), ct, ifNoneMatch);
  const headers: Record<string, string> = { ...xms, 'Content-Type': ct, Authorization: auth };
  if (!overwrite) headers['If-None-Match'] = ifNoneMatch;
  const r = await fetch(`https://${account}.blob.core.windows.net/${container}/${encPath(path)}`, {
    method: 'PUT',
    headers,
    body: buf,
  });
  if (r.status === 409 || r.status === 412) {
    throw new Error(
      `blob put refused: a blob already exists at ${container}/${path} (HTTP ${r.status}). ` +
        `Pass overwrite=true to intentionally replace it.`,
    );
  }
  if (!r.ok) throw new Error(`blob put ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return { path, container, bytes: buf.length, contentType: ct };
}

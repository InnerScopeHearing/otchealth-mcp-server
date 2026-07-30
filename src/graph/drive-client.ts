/**
 * Microsoft Graph DRIVE client — OneDrive file access for the role three-folder exchange pattern
 * (Outgoing / Incoming / Processed), generalized to ANY role's folders.
 *
 * PORTED FROM: skills/cfo-onedrive/onedrive.mjs (otchealth-claude-tools) — its ls (list children),
 * upload (PUT .../:/content), and download (GET .../:/content) Graph Drive calls. The REST shapes are
 * reproduced faithfully. The ONE deliberate difference is the AUTH MODEL, and it is unavoidable:
 *
 *   - The LOCAL skill runs as a delegated user (a rotating refresh token, scope Files.ReadWrite) and
 *     addresses the drive as `/me/drive/root:/<path>`. `/me` requires a signed-in user and cannot work
 *     from a server.
 *   - The GATEWAY has only APP-ONLY client credentials (GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET,
 *     scope .default) — the exact same token this repo already mints for Graph mail (see
 *     src/graph/api-client.ts getAccessToken, reused here). App-only has no `/me`, so we address a
 *     specific user's drive as `/users/{userPrincipalName}/drive/root:/<path>` instead. This requires
 *     the app registration to hold the Files.ReadWrite.All application permission with admin consent
 *     (mail already uses Mail.Send / Mail.ReadWrite the same way).
 *
 * The drive owner is GRAPH_DRIVE_USER (the OneDrive whose role folders are exchanged). Folder names
 * ("CLO Outgoing", "CTO Incoming", …) are PARAMETERS, never hardcoded, so any role's three folders
 * can be pointed at. Inert without Graph creds — the tools surface a clear "not configured" result.
 */

import { createHash } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
import { getAccessToken } from './api-client.js';

export class GraphDriveError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  constructor(args: { code: string; status: number; message: string; nextStep: string }) {
    super(args.message);
    this.name = 'GraphDriveError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
  }
}

/** True when Graph app creds + a drive owner are configured. */
export function driveConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET && env.GRAPH_DRIVE_USER);
}

function driveOwner(): string {
  const env = loadEnv();
  if (!env.GRAPH_DRIVE_USER) {
    throw new GraphDriveError({
      code: 'graph_drive_not_configured',
      status: 0,
      message: 'GRAPH_DRIVE_USER is not set (the OneDrive owner whose role folders are exchanged).',
      nextStep: 'Set GRAPH_DRIVE_USER to the drive owner UPN (e.g. matthew@innd.com) and grant the app Files.ReadWrite.All.',
    });
  }
  return env.GRAPH_DRIVE_USER;
}

/** Percent-encode each path segment; matches encPath() in the source skill. */
function encPath(p: string): string {
  return p
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

/** Address helper: /users/{owner}/drive/root  or  /users/{owner}/drive/root:/<path>: */
function itemRef(owner: string, path: string): string {
  const base = `/users/${encodeURIComponent(owner)}/drive/root`;
  const clean = path.replace(/^\/+|\/+$/g, '');
  return clean ? `${base}:/${encPath(clean)}:` : base;
}

async function graphFetch(method: string, path: string, opts?: { body?: Buffer | string; headers?: Record<string, string>; timeoutMs?: number }) {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `https://graph.microsoft.com/v1.0${path}`;
  // GET is read-only (safe to retry once); uploads are non-idempotent -> retries:0.
  const retries = method === 'GET' ? 1 : 0;
  return fetchWithBudget(
    url,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(opts?.headers || {}) },
      body: opts?.body,
    },
    { retries, timeoutMs: opts?.timeoutMs },
  );
}

export interface DriveItem {
  name: string;
  id: string;
  size: number | null;
  lastModified: string | null;
  isFolder: boolean;
  contentType: string | null;
}

/**
 * List the children of a folder path (relative to the drive root). Read-only.
 * Mirrors listChildren() in the source skill (…/children with paging via @odata.nextLink).
 */
export async function listFolder(folderPath: string): Promise<DriveItem[]> {
  const owner = driveOwner();
  const clean = folderPath.replace(/^\/+|\/+$/g, '');
  let url = clean
    ? `${itemRef(owner, clean)}/children?$select=name,id,size,lastModifiedDateTime,folder,file&$top=200`
    : `/users/${encodeURIComponent(owner)}/drive/root/children?$select=name,id,size,lastModifiedDateTime,folder,file&$top=200`;
  const out: DriveItem[] = [];
  while (url) {
    const r = await graphFetch('GET', url);
    if (r.status === 404) return out;
    if (!r.ok) throw new GraphDriveError({ code: `graph_drive_${r.status}`, status: r.status, message: `list "${folderPath}" ${r.status}: ${(await r.text()).slice(0, 160)}`, nextStep: 'Verify the folder path and that the app holds Files.Read.All on the drive owner.' });
    const j = (await r.json()) as { value?: any[]; '@odata.nextLink'?: string };
    for (const k of j.value || []) {
      out.push({
        name: k.name ?? '',
        id: k.id ?? '',
        size: typeof k.size === 'number' ? k.size : null,
        lastModified: k.lastModifiedDateTime ?? null,
        isFolder: Boolean(k.folder),
        contentType: k.file?.mimeType ?? null,
      });
    }
    url = j['@odata.nextLink'] || '';
  }
  return out;
}

/** Does a file already exist at folder/filename? Used for the fail-closed overwrite check on upload. */
export async function driveItemExists(folderPath: string, fileName: string): Promise<boolean> {
  const owner = driveOwner();
  const path = [folderPath.replace(/^\/+|\/+$/g, ''), fileName].filter(Boolean).join('/');
  const r = await graphFetch('GET', `${itemRef(owner, path)}?$select=id`);
  if (r.status === 404) return false;
  if (r.ok) return true;
  throw new GraphDriveError({ code: `graph_drive_${r.status}`, status: r.status, message: `stat "${path}" ${r.status}`, nextStep: 'Check the path + app permissions.' });
}

export interface DriveUploadResult {
  path: string;
  id: string;
  size: number | null;
}

/**
 * Microsoft Graph's SIMPLE content-upload endpoint (PUT …/content, what `uploadFile` below uses)
 * is documented to support files up to 250 MB (learn.microsoft.com/en-us/graph/api/driveitem-put-content,
 * "This method only supports files up to 250 MB in size", verified 2026-07-30). Larger files
 * require a resumable upload session (POST createUploadSession + chunked PUTs against the
 * returned uploadUrl), which this client does not implement. `uploadFile` refuses anything over
 * this ceiling before ever making the PUT (see the caller-side check in
 * tools/graph-drive/upload.ts and the belt-and-suspenders check inside uploadFile itself below)
 * rather than sending it to an endpoint that can't carry it. A chunked/resumable session is a
 * deferred follow-up, not implemented here.
 */
export const MAX_SIMPLE_UPLOAD_BYTES = 250 * 1024 * 1024;

/** Uploads (writes up to MAX_SIMPLE_UPLOAD_BYTES) get more time than the generic 8s API-call
 *  budget — a multi-megabyte PUT over a slow link can legitimately take longer than that, and an
 *  overly tight timeout aborting mid-transfer is itself a plausible truncation vector. */
const UPLOAD_TIMEOUT_MS = 30_000;

/**
 * Upload a file to folder/filename (relative to the drive root). Mirrors the source skill's
 * `upload` (PUT …:/content). Binary-safe (accepts a Buffer). Non-idempotent (retries:0).
 * Uses simple content upload (fine for the small documents the exchange folders carry — see
 * MAX_SIMPLE_UPLOAD_BYTES above for the hard ceiling on that).
 *
 * `size` is `null`, NEVER defaulted to `content.length`, when Graph's response omits a numeric
 * size. Defaulting it here used to mask a short/incomplete write (the caller-side integrity check
 * in tools/graph-drive/upload.ts compares this `size` against the bytes it sent — if this function
 * quietly substituted `content.length` whenever Graph's own confirmation was missing, that
 * comparison would trivially "pass" even on a write Graph never actually confirmed, which is
 * exactly the silent-success failure mode being fixed).
 */
export async function uploadFile(folderPath: string, fileName: string, content: Buffer, contentType?: string): Promise<DriveUploadResult> {
  // Belt-and-suspenders: tools/graph-drive/upload.ts already refuses an oversized payload before
  // calling this function, but that guard living only at the one current call site means a future
  // second caller could bypass it by omission. Enforcing it here too costs nothing and protects
  // every caller, present or future.
  if (content.length > MAX_SIMPLE_UPLOAD_BYTES) {
    throw new GraphDriveError({
      code: 'file_too_large_for_simple_upload',
      status: 413,
      message: `uploadFile: ${content.length} bytes exceeds the ${MAX_SIMPLE_UPLOAD_BYTES}-byte (250 MB) limit Microsoft Graph's simple upload endpoint supports.`,
      nextStep: 'Split the file or implement a resumable upload session (POST createUploadSession) for files over 250 MB.',
    });
  }
  const owner = driveOwner();
  const path = [folderPath.replace(/^\/+|\/+$/g, ''), fileName].filter(Boolean).join('/');
  const r = await graphFetch('PUT', `${itemRef(owner, path)}/content`, {
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: content,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
  if (!r.ok) throw new GraphDriveError({ code: `graph_drive_${r.status}`, status: r.status, message: `upload "${path}" ${r.status}: ${(await r.text()).slice(0, 160)}`, nextStep: 'Verify the folder exists and the app holds Files.ReadWrite.All.' });
  const j = (await r.json()) as { id?: string; size?: number };
  return { path, id: j.id ?? '', size: typeof j.size === 'number' ? j.size : null };
}

export interface DriveDownloadResult {
  found: boolean;
  contentType: string | null;
  size: number | null;
  text: string | null;
  base64: string | null;
}

/** Extensions Graph/OneDrive is known to mis-report (or not report at all, falling back to
 * application/octet-stream) on the simple content-upload/download path, even when the upload sent
 * an explicit, correct Content-Type. Confirmed live (CFO P1-D, 2026-07-30): uploading a .md file
 * with content_type:"text/markdown" round-tripped as application/octet-stream on download. This is
 * OneDrive inferring/storing the item's mimeType from the file EXTENSION rather than honoring an
 * arbitrary Content-Type sent on `PUT :/content` (Graph does not expose a way to force-set
 * driveItem.file.mimeType directly) -- so relying on the response's Content-Type header alone to
 * decide text-vs-binary is unreliable for any extension OneDrive does not have a built-in mapping
 * for. Extend by filename extension as a second signal so a genuinely textual file we KNOW the
 * extension of still comes back as text even when Graph reports a generic/wrong content-type. */
const TEXTUAL_EXTENSIONS = /\.(md|markdown|txt|csv|json|jsonl|ndjson|xml|yaml|yml|log|ts|tsx|js|jsx|mjs|cjs|css|html|htm|sh|sql|toml|ini|env)$/i;

function looksTextual(contentType: string | null, fileName?: string): boolean {
  if (contentType && /^(text\/|application\/(json|xml|x-ndjson|javascript)|application\/.*\+(json|xml))/i.test(contentType)) {
    return true;
  }
  // Fall back to the extension when the reported type is absent/generic (see TEXTUAL_EXTENSIONS
  // comment above) -- but only ever WIDENS text detection, never narrows a type Graph already
  // reported correctly as textual.
  return Boolean(fileName && TEXTUAL_EXTENSIONS.test(fileName));
}

/**
 * Download a file's content by folder + filename. Read-only. Mirrors the source skill's `download`
 * (GET …:/content). Textual content returned as text; binary (or force_base64) as base64.
 */
export async function downloadFile(folderPath: string, fileName: string, forceBase64 = false): Promise<DriveDownloadResult> {
  const owner = driveOwner();
  const path = [folderPath.replace(/^\/+|\/+$/g, ''), fileName].filter(Boolean).join('/');
  const r = await graphFetch('GET', `${itemRef(owner, path)}/content`);
  if (r.status === 404) return { found: false, contentType: null, size: null, text: null, base64: null };
  if (!r.ok) throw new GraphDriveError({ code: `graph_drive_${r.status}`, status: r.status, message: `download "${path}" ${r.status}: ${(await r.text()).slice(0, 160)}`, nextStep: 'Verify the file path + app permissions.' });
  const contentType = r.headers.get('content-type');
  const buf = Buffer.from(await r.arrayBuffer());
  if (!forceBase64 && looksTextual(contentType, fileName)) {
    return { found: true, contentType, size: buf.length, text: buf.toString('utf8'), base64: null };
  }
  return { found: true, contentType, size: buf.length, text: null, base64: buf.toString('base64') };
}

export interface DriveDownloadHashResult {
  found: boolean;
  contentType: string | null;
  size: number | null;
  sha256: string | null;
}

/**
 * Download a file's content and return ONLY its sha256/size/contentType -- never the bytes
 * themselves, in any encoding. A dedicated sibling to downloadFile (not a `verify_sha256_only`
 * flag added onto it) so this path never allocates a base64 string it would immediately throw
 * away: downloadFile's own base64 branch already costs one extra full-size string allocation
 * (`buf.toString('base64')`, ~1.33x the byte length) plus a caller that then had to
 * `Buffer.from(base64, 'base64')` it BACK to hash it paid for a third allocation on top of that
 * (review finding, 2026-07-30, PR #175 round 2) -- three copies of the file in memory at once for
 * a caller that only ever wanted a 64-character hex digest. This function holds exactly one Buffer
 * (`buf`, the raw response bytes) for the lifetime of the call.
 *
 * NOT a fully streaming hash (piping the HTTP response body through the hash incrementally without
 * ever buffering the whole file) -- `graphFetch`'s Response is still consumed via `arrayBuffer()`
 * below, so this function's peak memory is still O(file size), just 1x instead of the prior ~3.66x.
 * A true zero-buffer streaming hash would touch graphFetch itself (a shared low-level helper other
 * call sites also use) and is a larger, separate change; flagged as a follow-up, not done here
 * under time pressure to ship the correctness/memory fixes already found. If OneDrive files in the
 * role folders this serves grow large enough for even 1x file size to matter, a size ceiling ahead
 * of the fetch (mirroring upload.ts's MAX_SIMPLE_UPLOAD_BYTES refusal) is the next cheap lever.
 */
export async function downloadFileHash(folderPath: string, fileName: string): Promise<DriveDownloadHashResult> {
  const owner = driveOwner();
  const path = [folderPath.replace(/^\/+|\/+$/g, ''), fileName].filter(Boolean).join('/');
  const r = await graphFetch('GET', `${itemRef(owner, path)}/content`);
  if (r.status === 404) return { found: false, contentType: null, size: null, sha256: null };
  if (!r.ok) throw new GraphDriveError({ code: `graph_drive_${r.status}`, status: r.status, message: `download "${path}" ${r.status}: ${(await r.text()).slice(0, 160)}`, nextStep: 'Verify the file path + app permissions.' });
  const contentType = r.headers.get('content-type');
  const buf = Buffer.from(await r.arrayBuffer());
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { found: true, contentType, size: buf.length, sha256 };
}

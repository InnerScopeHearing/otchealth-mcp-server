import { createHash, randomUUID } from 'node:crypto';
import type { DaytonaBinding, DaytonaMission } from './contract.js';
import { DaytonaBrowserError } from './contract.js';
import { assertDaytonaBinding, assertDaytonaMission } from './store.js';
import { BROWSER_FILE_MAX_BYTES } from '../browser-cloud/file-broker.js';

export interface DaytonaStagePayload {
  version: 1; profileKey: string; sessionId: string; principalHash: string;
  transferId: string; relativePath: string; stagingId: string; byteLength: number; sha256: string;
}
export interface ControlledDaytonaFileUpload {
  binding: DaytonaBinding; session: DaytonaMission; path: string; body: Uint8Array;
  /** Trusted toolbox metadata and exact origin pins, obtained after owned-sandbox inspection. */
  toolboxBaseUrl: string; allowedOrigins: readonly string[]; token: string;
  remaining: () => number; fetchImpl?: typeof fetch;
  /** Fixed sudo -n transfer-stage.py recipe only. Never a caller command or root filesystem API. */
  promote: (payload: DaytonaStagePayload, remaining: () => number) => Promise<{ staged: true; sha256: string; byteLength: number }>;
}
const fail = (code: string): never => { throw new DaytonaBrowserError(code); };

/** SDK0.224.1 multipart staging as its own UID, then an exact validated root helper. */
export async function uploadDaytonaControlledFile(input: ControlledDaytonaFileUpload): Promise<void> {
  assertDaytonaBinding(input.binding);
  assertDaytonaMission(input.session);
  if (input.session.phase !== 'ACTIVE' || input.session.sensitiveOutputSuppressed || input.session.expiresAt <= Date.now() || input.session.owner !== input.binding.owner || input.session.ownerSubjectHash !== input.binding.ownerSubjectHash || input.session.sandboxId !== input.binding.sandboxId || input.session.profileKey !== input.binding.profileKey || typeof input.promote !== 'function') return fail('owner_forbidden');
  const prefix = input.binding.profilePath.slice(0, -'/chromium'.length) + '/uploads/';
  const suffix = input.path.startsWith(prefix) ? input.path.slice(prefix.length) : '';
  const parts = suffix.split('/');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parts[0] ?? '') || parts.length < 2 || parts.length > 9 || parts.slice(1).some(part => part.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(part) || part.includes('..') || /[. ]$/.test(part))) return fail('daytona_upload_path_invalid');
  let base: URL; try { base = new URL(input.toolboxBaseUrl); } catch { return fail('daytona_toolbox_origin_forbidden'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.port || base.pathname.includes('..') || base.pathname.includes('%') || !input.allowedOrigins.includes(base.origin)) return fail('daytona_toolbox_origin_forbidden');
  if (typeof input.token !== 'string' || !input.token.length || input.token.length > 8192 || /[\r\n]/.test(input.token) || !(input.body instanceof Uint8Array) || input.body.length < 1 || input.body.length > BROWSER_FILE_MAX_BYTES) return fail('daytona_upload_invalid');
  const body = Buffer.from(input.body), fetcher = input.fetchImpl ?? fetch;
  const root = `${base.href.replace(/\/+$/, '')}/${encodeURIComponent(input.binding.sandboxId)}`;
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    const timeout = Math.min(20000, input.remaining()); if (!Number.isFinite(timeout) || timeout < 1) return fail('daytona_transfer_timeout');
    try {
      const response = await fetcher(url, { ...init, headers: { authorization: `Bearer ${input.token}` }, redirect: 'error', signal: AbortSignal.timeout(Math.floor(timeout)) });
      input.remaining(); if (!response.ok) { await response.body?.cancel().catch(() => {}); return fail('daytona_upload_unconfirmed'); }
      return response;
    } catch (error) { if (error instanceof DaytonaBrowserError) throw error; return fail('daytona_upload_unconfirmed'); }
  };
  const stagingId = randomUUID(), stagingDirectory = `/tmp/otc-browser-upload-${stagingId}`, stagingPath = `${stagingDirectory}/payload.bin`;
  const folder = await request(`${root}/files/folder?${new URLSearchParams({ path: stagingDirectory, mode: '700' })}`, { method: 'POST' });
  await folder.body?.cancel().catch(() => {});
  const form = new FormData(); form.append('files[0].path', stagingPath); form.append('files[0].file', new Blob([body]), 'payload.bin');
  const uploaded = await request(`${root}/files/bulk-upload`, { method: 'POST', body: form });
  if (!uploaded.body) return fail('daytona_upload_unconfirmed');
  const reader = uploaded.body.getReader(); let bytes = Buffer.alloc(0);
  try {
    while (true) { input.remaining(); const next = await reader.read(); if (next.done) break; if (bytes.length + next.value.length > 32768) { await reader.cancel(); return fail('daytona_upload_unconfirmed'); } bytes = Buffer.concat([bytes, next.value]); }
  } finally { reader.releaseLock(); }
  let result: unknown; try { result = JSON.parse(bytes.toString('utf8')); } catch { return fail('daytona_upload_unconfirmed'); }
  // Official SDK UploadFilesResponse.errors is nullable. Actual bytes are still
  // independently SHA-verified by the root helper; a 200 alone is not success.
  if (!result || typeof result !== 'object' || Array.isArray(result) || ('errors' in result && result.errors !== null && (!Array.isArray(result.errors) || result.errors.length))) return fail('daytona_upload_unconfirmed');
  input.remaining();
  const query = new URLSearchParams({ path: stagingPath, mode: '600' });
  const permissions = await request(`${root}/files/permissions?${query}`, { method: 'POST' });
  await permissions.body?.cancel().catch(() => {}); input.remaining();
  const sha256 = createHash('sha256').update(body).digest('hex');
  const receipt = await input.promote({ version: 1, profileKey: input.binding.profileKey, sessionId: input.session.sessionId, principalHash: input.binding.ownerSubjectHash, transferId: parts[0]!, relativePath: parts.slice(1).join('/'), stagingId, byteLength: body.length, sha256 }, input.remaining);
  input.remaining();
  if (!receipt || receipt.staged !== true || receipt.sha256 !== sha256 || receipt.byteLength !== body.length) return fail('daytona_upload_unconfirmed');
}

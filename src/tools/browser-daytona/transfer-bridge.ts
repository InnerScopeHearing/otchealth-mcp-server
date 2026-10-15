import { createHash, randomUUID } from 'node:crypto';
import type { BrowserCaptureMetadata, CloudBrowserAction, CloudBrowserStore } from '../browser-cloud/contract.js';
import type { BrowserFileBroker, BrowserFileRecord } from '../browser-cloud/file-broker.js';
import { BROWSER_FILE_MAX_BYTES, validBrowserFileScanReceipt } from '../browser-cloud/file-broker.js';
import type { BrowserFileTransferReceipt } from '../browser-cloud/provider-files.js';
import { captureBrowserArtifact } from '../browser-cloud/captures.js';
import { createTrustedBrowserBinaryValidator, type TrustedBrowserBinaryValidator } from '../browser-cloud/binary-validation.js';
import { DaytonaBrowserError, type DaytonaBinding, type DaytonaMission } from './contract.js';
import { assertDaytonaBinding, assertDaytonaMission } from './store.js';

export type DaytonaTransferAction = Extract<CloudBrowserAction, { type: 'upload' | 'capture' }>;
export type DaytonaDirectoryEntry = { fileId: string; relativePath: string };
export type DaytonaUploadFile = { relativePath: string; filename: string; contentType: string; byteLength: number; sha256: string };
export type DaytonaUploadDescriptor = { phase: 'prepare' | 'attach'; transferId: string; directory: boolean; files: DaytonaUploadFile[] };
export type DaytonaDirectoryReceipt = { status: 'attached'; directory: true; fileCount: number; byteLength: number; files: DaytonaUploadFile[] };
export interface DaytonaTransferRemote {
  /** Actual fixed dispatcher execution; descriptor is server-generated, never caller input. */
  run(binding: DaytonaBinding, session: DaytonaMission, action: DaytonaTransferAction, descriptor: DaytonaUploadDescriptor | undefined, remaining: () => number, principal: string): Promise<unknown>;
  /** Actual REST/SDK bytes upload, to this exact generated destination only. */
  upload(binding: DaytonaBinding, session: DaytonaMission, path: string, body: Uint8Array, remaining: () => number, principal: string): Promise<void>;
}
export interface DaytonaTransferBridgePort {
  execute(binding: DaytonaBinding, session: DaytonaMission, action: DaytonaTransferAction, timeoutSeconds: number, principal: string): Promise<BrowserCaptureMetadata | BrowserFileTransferReceipt>;
}
export interface DaytonaTransferBridgeOptions {
  remote: DaytonaTransferRemote;
  files?: Pick<BrowserFileBroker, 'forUpload'>;
  captures?: Pick<CloudBrowserStore, 'createCapture'>;
  validator?: TrustedBrowserBinaryValidator;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (code: string): never => { throw new DaytonaBrowserError(code); };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const segment = (value: string) => value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(value) && !value.includes('..') && !/[. ]$/.test(value);
function plain(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('daytona_transfer_invalid'); return value as Record<string, unknown>; }

/** Explicit internal folder contract. Existing single-file MCP input does NOT accept this manifest. */
export function validateDaytonaDirectoryManifest(input: unknown): DaytonaDirectoryEntry[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) return fail('daytona_directory_manifest_invalid');
  const paths = new Set<string>(); const ids = new Set<string>(); let root: string | undefined;
  return input.map(item => {
    const value = plain(item);
    if (Object.keys(value).sort().join(',') !== 'fileId,relativePath' || typeof value.fileId !== 'string' || !UUID.test(value.fileId) || typeof value.relativePath !== 'string' || value.relativePath.length > 512) return fail('daytona_directory_manifest_invalid');
    const parts = value.relativePath.split('/');
    if (parts.length < 2 || parts.length > 8 || parts.some(part => !segment(part)) || paths.has(value.relativePath) || ids.has(value.fileId) || (root && parts[0] !== root)) return fail('daytona_directory_manifest_invalid');
    root = parts[0]; paths.add(value.relativePath); ids.add(value.fileId);
    return { fileId: value.fileId, relativePath: value.relativePath };
  });
}

/** Broker/immutable capture-store bridge. No raw file paths, scripts, cookies or captures leave it. */
export class DaytonaTransferBridge implements DaytonaTransferBridgePort {
  private readonly validator: TrustedBrowserBinaryValidator;
  constructor(private readonly options: DaytonaTransferBridgeOptions) { this.validator = options.validator ?? createTrustedBrowserBinaryValidator(); }
  private bound(binding: DaytonaBinding, session: DaytonaMission, principal: string): void {
    assertDaytonaBinding(binding); assertDaytonaMission(session);
    if (binding.owner !== session.owner || binding.ownerSubjectHash !== principal || session.ownerSubjectHash !== principal || binding.profileKey !== session.profileKey || binding.sandboxId !== session.sandboxId || session.phase !== 'ACTIVE' || session.sensitiveOutputSuppressed) fail('owner_forbidden');
    if (session.expiresAt <= Date.now()) fail('session_expired');
  }
  private async budget<T>(seconds: number, run: (remaining: () => number) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 120) return fail('invalid_duration');
    const deadline = Date.now() + seconds * 1000;
    const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) return fail('daytona_transfer_timeout'); return ms; };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([run(remaining), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DaytonaBrowserError('daytona_transfer_timeout')), seconds * 1000); })]); }
    catch (error) {
      if (error instanceof DaytonaBrowserError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (typeof code === 'string' && ['file_not_ready', 'file_expired', 'file_integrity_failed', 'owner_forbidden'].includes(code)) return fail(code);
      return fail('daytona_transfer_unconfirmed');
    }
    finally { clearTimeout(timer); }
  }
  async execute(binding: DaytonaBinding, session: DaytonaMission, action: DaytonaTransferAction, seconds: number, principal: string): Promise<BrowserCaptureMetadata | BrowserFileTransferReceipt> {
    this.bound(binding, session, principal);
    if (action.type === 'capture') {
      if (!this.options.captures || action.request.type !== 'screenshot' || (action.request.format && action.request.format !== 'png')) return fail('daytona_capture_unsupported');
      return this.budget(seconds, async remaining => {
        const wire = plain(await this.options.remote.run(binding, session, action, undefined, remaining, principal)); remaining();
        const data = plain(wire.capture);
        if (data.contentType !== 'image/png' || typeof data.data !== 'string' || Object.keys(data).some(key => !['contentType', 'data'].includes(key))) return fail('daytona_capture_invalid');
        const artifact = await captureBrowserArtifact({ command: async method => { if (method !== 'Page.captureScreenshot') return fail('daytona_capture_invalid'); remaining(); return { data: data.data }; } }, 'owned-daytona-frame', { type: 'screenshot', format: 'png' }, remaining,
          input => this.validator.validate(input));
        remaining(); this.bound(binding, session, principal);
        const metadata = await this.options.captures!.createCapture(session.owner, session.sessionId, artifact, Date.now(), principal); remaining();
        if (metadata.owner !== session.owner || metadata.ownerSubjectHash !== principal || metadata.sessionId !== session.sessionId || metadata.sha256 !== artifact.sha256 || metadata.byteLength !== artifact.body.length || metadata.contentType !== 'image/png' || !/^bca_[a-f0-9-]{36}$/i.test(metadata.id) || !Number.isSafeInteger(metadata.createdAt) || metadata.createdAt < 0 || metadata.createdAt > Date.now()) return fail('daytona_capture_storage_invalid');
        return { id: metadata.id, owner: metadata.owner, ownerSubjectHash: principal, sessionId: metadata.sessionId, contentType: 'image/png', byteLength: metadata.byteLength, sha256: metadata.sha256, createdAt: metadata.createdAt };
      });
    }
    if (action.type !== 'upload' || !UUID.test(action.fileId) || typeof action.selector !== 'string' || action.selector.length < 1 || action.selector.length > 256 || /[\u0000-\u001f\u007f]/.test(action.selector)) return fail('invalid_action');
    return this.budget(seconds, remaining => this.attach(binding, session, action, [{ fileId: action.fileId }], false, remaining, principal)) as Promise<BrowserFileTransferReceipt>;
  }
  /** Called only by a future explicitly typed directory tool while its owned mission lock is held. */
  async uploadDirectory(binding: DaytonaBinding, session: DaytonaMission, selector: string, entries: unknown, seconds: number, principal: string): Promise<DaytonaDirectoryReceipt> {
    this.bound(binding, session, principal); const manifest = validateDaytonaDirectoryManifest(entries);
    if (typeof selector !== 'string' || selector.length < 1 || selector.length > 256 || /[\u0000-\u001f\u007f]/.test(selector)) return fail('invalid_action');
    return this.budget(seconds, remaining => this.attach(binding, session, { type: 'upload', selector, fileId: manifest[0]!.fileId }, manifest, true, remaining, principal)) as Promise<DaytonaDirectoryReceipt>;
  }
  private async attach(binding: DaytonaBinding, session: DaytonaMission, action: Extract<DaytonaTransferAction, { type: 'upload' }>, entries: Array<{ fileId: string; relativePath?: string }>, directory: boolean, remaining: () => number, principal: string): Promise<BrowserFileTransferReceipt | DaytonaDirectoryReceipt> {
    if (!this.options.files) return fail('daytona_upload_unavailable');
    const staged: Array<{ record: BrowserFileRecord; body: Uint8Array; relativePath: string }> = []; let total = 0;
    for (const entry of entries) {
      remaining(); const loaded = await this.options.files.forUpload(session.owner, entry.fileId, principal); remaining();
      const record = structuredClone(loaded.record), body = Uint8Array.from(loaded.body);
      if (record.id !== entry.fileId || record.owner !== session.owner || record.ownerSubjectHash !== principal) return fail('owner_forbidden');
      if (record.status !== 'ready' || !validBrowserFileScanReceipt(record.scanReceipt, record.sha256, record.byteLength) || record.scanReceipt.scannedAt > Date.now()) return fail('file_not_ready');
      if (record.expiresAt <= Date.now()) return fail('file_expired');
      if (!segment(record.filename) || body.length !== record.byteLength || body.length < 1 || digest(body) !== record.sha256 || (total += body.length) > BROWSER_FILE_MAX_BYTES) return fail('file_integrity_failed');
      if (!['text/plain', 'text/csv'].includes(record.contentType)) { const validation = await this.validator.validate({ contentType: record.contentType, body }); remaining(); if (validation?.complete !== true) return fail('file_not_ready'); }
      const relativePath = entry.relativePath ?? record.filename;
      if (relativePath.split('/').at(-1) !== record.filename) return fail('daytona_directory_manifest_invalid');
      staged.push({ record, body, relativePath });
    }
    const transferId = randomUUID();
    const files = staged.map(({ record, relativePath }) => ({ relativePath, filename: record.filename, contentType: record.contentType, byteLength: record.byteLength, sha256: record.sha256 }));
    const descriptor: DaytonaUploadDescriptor = { phase: 'prepare', transferId, directory, files };
    // Match the actual bounded dispatcher wire protocol before any preparation
    // or SDK write. A valid per-file path is not an unlimited combined request.
    const request = { version: 1, op: 'execute', profileKey: binding.profileKey, profilePath: binding.profilePath, timeoutMs: 18000, sessionId: session.sessionId, action, principalHash: principal, upload: descriptor };
    if (Buffer.from(JSON.stringify(request)).toString('base64url').length > 32768) return fail('daytona_directory_manifest_too_large');
    this.bound(binding, session, principal); remaining();
    const prepared = plain(await this.options.remote.run(binding, session, action, descriptor, remaining, principal)); remaining();
    if (prepared.prepared !== true) return fail('daytona_upload_prepare_unconfirmed');
    for (const file of staged) { this.bound(binding, session, principal); remaining(); await this.options.remote.upload(binding, session, `${binding.profilePath.slice(0, -'/chromium'.length)}/uploads/${transferId}/${file.relativePath}`, file.body, remaining, principal); remaining(); }
    this.bound(binding, session, principal);
    const attached = plain(await this.options.remote.run(binding, session, action, { ...descriptor, phase: 'attach' }, remaining, principal)); remaining();
    if (directory) {
      const receipt = plain(attached.directoryReceipt);
      if (receipt.status !== 'attached' || receipt.directory !== true || receipt.fileCount !== files.length || receipt.byteLength !== total || !Array.isArray(receipt.files) || receipt.files.length !== files.length || !receipt.files.every((value, index) => {
        const observed = plain(value), expected = files[index]!;
        return Object.keys(observed).length === 5 && Object.entries(expected).every(([key, field]) => observed[key] === field);
      })) return fail('file_transfer_uncertain');
      return { status: 'attached', directory: true, fileCount: files.length, byteLength: total, files };
    }
    const receipt = plain(attached.fileReceipt), record = staged[0]!.record;
    if (receipt.status !== 'attached' || receipt.filename !== record.filename || receipt.contentType !== record.contentType || receipt.byteLength !== record.byteLength || receipt.sha256 !== record.sha256) return fail('file_transfer_uncertain');
    return { status: 'attached', filename: record.filename, contentType: record.contentType, byteLength: record.byteLength, sha256: record.sha256 };
  }
}

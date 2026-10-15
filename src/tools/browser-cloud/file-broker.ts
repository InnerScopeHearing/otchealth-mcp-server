import { createHash, randomUUID } from 'node:crypto';

export const BROWSER_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const BROWSER_FILE_TTL_MS = 60 * 60 * 1_000;

export type BrowserFileStatus = 'quarantined' | 'ready' | 'partial';
export type BrowserFileScanReceipt = { verdict: 'clean'; scanner: 'clamav'; sha256: string; byteLength: number; scannedAt: number; engineVersion: string; signatureVersion: string; signaturesUpdatedAt: number };

/** Public metadata only. File bytes and storage keys never leave the broker. */
export type BrowserFileRecord = {
  id: string;
  owner: string;
  /** Trusted OAuth connection binding; legacy internal records may be unbound. */
  ownerSubjectHash?: string;
  filename: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  status: BrowserFileStatus;
  expiresAt: number;
  scanReceipt?: BrowserFileScanReceipt;
};

/** Implementations must treat keys as generated opaque references and reject replacement. */
export interface BrowserFileStore {
  put(key: string, record: BrowserFileRecord, body: Uint8Array): Promise<void>;
  get(key: string): Promise<{ record: BrowserFileRecord; body: Uint8Array } | null>;
}

export interface BrowserFileScanner {
  scan(input: { filename: string; contentType: string; body: Uint8Array }): Promise<BrowserFileScanReceipt | { verdict: 'infected' | 'error' } | 'infected' | 'error'>;
}

export function validBrowserFileScanReceipt(value: unknown, sha256: string, byteLength: number): value is BrowserFileScanReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as BrowserFileScanReceipt;
  const fields = ['verdict', 'scanner', 'sha256', 'byteLength', 'scannedAt', 'engineVersion', 'signatureVersion', 'signaturesUpdatedAt'];
  if (Object.keys(value).some(field => !fields.includes(field))) return false;
  return receipt.verdict === 'clean' && receipt.scanner === 'clamav' && receipt.sha256 === sha256 && /^[a-f0-9]{64}$/.test(receipt.sha256)
    && receipt.byteLength === byteLength && Number.isSafeInteger(receipt.byteLength) && receipt.byteLength > 0 && receipt.byteLength <= BROWSER_FILE_MAX_BYTES
    && Number.isSafeInteger(receipt.scannedAt) && receipt.scannedAt >= 0 && Number.isSafeInteger(receipt.signaturesUpdatedAt) && receipt.signaturesUpdatedAt >= 0
    && receipt.signaturesUpdatedAt <= receipt.scannedAt && receipt.scannedAt - receipt.signaturesUpdatedAt <= 48 * 60 * 60 * 1000
    && typeof receipt.engineVersion === 'string' && receipt.engineVersion.length <= 64 && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(receipt.engineVersion) && /^[1-9][0-9]{0,11}$/.test(receipt.signatureVersion);
}

/** Trusted in-process adapter. Synthetic implementations belong in tests only. */
interface BrowserFileValidator {
  validate(input: { contentType: string; body: Uint8Array }): Promise<{ complete: boolean }>;
}

export type BrowserFileUploadEvidence = { sha256: string; byteLength: number; completed: boolean };

export class BrowserFileBrokerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BrowserFileBrokerError';
  }
}

const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'text/csv': ['csv'],
  'text/plain': ['txt'],
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
};
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function fail(code: string, message: string): never {
  throw new BrowserFileBrokerError(code, message);
}

function validOwner(owner: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,63}$/i.test(owner);
}

function checkedPrincipalHash(hash: string | undefined): string | undefined {
  if (hash === undefined) return undefined;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) fail('principal_binding_invalid', 'The browser file connection binding is invalid.');
  return hash.toLowerCase();
}

function safeFilename(filename: string, contentType: string): boolean {
  if (filename.length < 1 || filename.length > 128 || filename.startsWith('.') || filename.endsWith('.') || filename.endsWith(' ')) return false;
  if (!/^[a-z0-9][a-z0-9._ -]*$/i.test(filename) || filename.includes('..')) return false;
  if (filename.includes('/') || filename.includes('\\') || /[\u0000-\u001f\u007f]/.test(filename)) return false;
  const extension = filename.split('.').at(-1)?.toLowerCase();
  return Boolean(extension && MIME_EXTENSIONS[contentType]?.includes(extension));
}

function textContent(body: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    if (text.includes('\0') || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
    if (/(?:<!doctype\s+html|<\/?(?:html|script|iframe|svg|body|head)\b|javascript\s*:)/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

function pngHasBasicStructure(body: Uint8Array): boolean {
  if (body.length < 8 || !PNG_SIGNATURE.every((byte, index) => body[index] === byte)) return false;
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  while (offset + 12 <= body.length) {
    const length = new DataView(body.buffer, body.byteOffset + offset, 4).getUint32(0, false);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const next = dataOffset + length + 4;
    if (next > body.length) return false;
    const type = String.fromCharCode(body[typeOffset]!, body[typeOffset + 1]!, body[typeOffset + 2]!, body[typeOffset + 3]!);
    // PNG chunk names contain ASCII letters; ancillary chunks use lowercase.
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return false;
      sawHeader = true;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') return length === 0 && sawData && next === body.length;
    offset = next;
  }
  return false;
}

function jpegHasBasicStructure(body: Uint8Array): boolean {
  if (body.length < 12 || body[0] !== 0xff || body[1] !== 0xd8 || body.at(-2) !== 0xff || body.at(-1) !== 0xd9) return false;
  let offset = 2;
  let sawFrame = false;
  while (offset < body.length - 2) {
    if (body[offset] !== 0xff) return false;
    while (body[offset] === 0xff) offset += 1;
    const marker = body[offset]!;
    offset += 1;
    if (marker === 0xda) {
      if (!sawFrame || offset + 2 > body.length - 2) return false;
      const length = (body[offset]! << 8) | body[offset + 1]!;
      const segmentEnd = offset + length;
      return length >= 6 && segmentEnd < body.length - 2;
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (offset + 2 > body.length - 2) return false;
    const length = (body[offset]! << 8) | body[offset + 1]!;
    if (length < 2 || offset + length > body.length - 2) return false;
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) return false;
      sawFrame = true;
    }
    offset += length;
  }
  return false;
}

function supportedContent(contentType: string, body: Uint8Array): boolean {
  if (contentType === 'text/csv' || contentType === 'text/plain') return textContent(body) !== null;
  if (contentType === 'application/pdf') {
    const text = new TextDecoder('latin1').decode(body);
    return body.length >= 12 && /^%PDF-(?:1\.[0-7]|2\.0)(?:\r?\n|$)/.test(text) && text.trimEnd().endsWith('%%EOF');
  }
  if (contentType === 'image/png') return pngHasBasicStructure(body);
  if (contentType === 'image/jpeg') return jpegHasBasicStructure(body);
  return false;
}

function isBinaryContent(contentType: string): boolean {
  return contentType === 'application/pdf' || contentType === 'image/png' || contentType === 'image/jpeg';
}

function cloneRecord(record: BrowserFileRecord): BrowserFileRecord {
  return { ...record, ...(record.scanReceipt ? { scanReceipt: { ...record.scanReceipt } } : {}) };
}

/**
 * Owner-bound file staging and upload-receipt validation. This broker stores
 * bytes behind generated keys; it does not mount files or contact a provider.
 */
export class BrowserFileBroker {
  constructor(
    private readonly store: BrowserFileStore,
    private readonly options: { scanner?: BrowserFileScanner; validator?: BrowserFileValidator; allowValidatedText?: boolean; now?: () => number } = {},
  ) {}

  async stage(owner: string, input: { filename: string; contentType: string; body: Uint8Array }, principalHash?: string): Promise<BrowserFileRecord> {
    if (!validOwner(owner)) fail('invalid_owner', 'File owner is invalid.');
    const ownerSubjectHash = checkedPrincipalHash(principalHash);
    if (!input || typeof input !== 'object' || typeof input.filename !== 'string' || typeof input.contentType !== 'string' || !(input.body instanceof Uint8Array)) {
      fail('invalid_file', 'File name, content type, or body is invalid.');
    }
    const { filename, contentType, body } = input;
    if (typeof contentType !== 'string' || !Object.hasOwn(MIME_EXTENSIONS, contentType) || !safeFilename(filename, contentType)) {
      fail('invalid_file_type', 'File name or content type is not permitted.');
    }
    if (body.byteLength === 0 || body.byteLength > BROWSER_FILE_MAX_BYTES) fail('invalid_file_size', 'File size is outside the permitted bounds.');
    const bytes = new Uint8Array(body);
    if (!supportedContent(contentType, bytes)) fail('invalid_file_content', 'File bytes do not match the permitted content type.');

    const id = randomUUID();
    const createdAt = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail('invalid_clock', 'File staging clock is invalid.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const expiresAt = createdAt + BROWSER_FILE_TTL_MS;
    if (!Number.isSafeInteger(expiresAt)) fail('invalid_clock', 'File expiration is invalid.');
    let status: BrowserFileStatus = 'quarantined';
    let scanClean = false;
    let scanReceipt: BrowserFileScanReceipt | undefined;
    if (this.options.scanner) {
      try {
        const verdict = await this.options.scanner.scan({ filename, contentType, body: new Uint8Array(bytes) });
        const checkedAt = (this.options.now ?? Date.now)();
        if (validBrowserFileScanReceipt(verdict, sha256, bytes.byteLength) && verdict.scannedAt >= createdAt && verdict.scannedAt <= checkedAt) {
          scanClean = true;
          scanReceipt = { ...verdict };
        }
      } catch {
        // Scanner errors fail closed to quarantine.
      }
    }
    if (scanClean && !isBinaryContent(contentType)) status = 'ready';
    // This opts in only for strictly validated plain text when no scanner is configured; it is
    // not an antivirus verdict. A configured scanner's infected/error result can never be bypassed.
    if (!this.options.scanner && this.options.allowValidatedText === true && !isBinaryContent(contentType)) status = 'ready';
    if (scanClean && isBinaryContent(contentType) && this.options.validator) {
      try {
        const verdict = await this.options.validator.validate({ contentType, body: new Uint8Array(bytes) });
        if (verdict?.complete === true) status = 'ready';
      } catch {
        // Validation errors fail closed to quarantine.
      }
    }
    const record: BrowserFileRecord = { id, owner, ...(ownerSubjectHash === undefined ? {} : { ownerSubjectHash }), filename, contentType, byteLength: bytes.byteLength, sha256, status, expiresAt, ...(scanReceipt ? { scanReceipt } : {}) };
    const key = this.storageKey(owner, id);
    try {
      await this.store.put(key, cloneRecord(record), new Uint8Array(bytes));
    } catch {
      fail('file_store_failed', 'File could not be staged safely.');
    }
    return cloneRecord(record);
  }

  async get(owner: string, fileId: string, principalHash?: string): Promise<BrowserFileRecord> {
    const stored = await this.load(owner, fileId, principalHash);
    if (!stored) fail('owner_forbidden', 'File is unavailable to this owner.');
    return cloneRecord(stored.record);
  }

  /** Trusted server-only provider port. This method must never be exposed as an MCP response. */
  async forUpload(owner: string, fileId: string, principalHash?: string): Promise<{ record: BrowserFileRecord; body: Uint8Array }> {
    const stored = await this.load(owner, fileId, principalHash);
    if (!stored) fail('owner_forbidden', 'File is unavailable to this owner.');
    if (stored.record.status !== 'ready' || (this.options.scanner && stored.record.scanReceipt === undefined)) fail('file_not_ready', 'File is not cleared for browser transfer.');
    return { record: cloneRecord(stored.record), body: new Uint8Array(stored.body) };
  }

  async verifyUpload(owner: string, fileId: string, evidence: BrowserFileUploadEvidence, principalHash?: string): Promise<{ verified: true }> {
    const stored = await this.load(owner, fileId, principalHash);
    if (!stored) fail('owner_forbidden', 'File is unavailable to this owner.');
    const record = stored.record;
    if (record.status !== 'ready' || (this.options.scanner && record.scanReceipt === undefined)) fail('file_not_ready', 'File is not cleared for upload verification.');
    if (!evidence || evidence.completed !== true) fail('upload_partial', 'Upload is partial; receipt does not confirm a complete transfer.');
    if (!Number.isSafeInteger(evidence.byteLength) || evidence.byteLength !== record.byteLength) fail('upload_size_mismatch', 'Upload receipt byte length does not match the staged file.');
    if (typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256) || evidence.sha256 !== record.sha256) fail('upload_hash_mismatch', 'Upload receipt hash does not match the staged file.');
    return { verified: true };
  }

  private async load(owner: string, fileId: string, principalHash?: string): Promise<{ record: BrowserFileRecord; body: Uint8Array } | null> {
    if (!validOwner(owner) || !/^[0-9a-f-]{36}$/i.test(fileId)) fail('invalid_file_reference', 'File reference is invalid.');
    const expectedPrincipal = checkedPrincipalHash(principalHash);
    let stored: { record: BrowserFileRecord; body: Uint8Array } | null;
    try {
      stored = await this.store.get(this.storageKey(owner, fileId));
    } catch {
      fail('file_store_failed', 'File metadata is unavailable.');
    }
    if (!stored || stored.record.id !== fileId || stored.record.owner !== owner ||
        stored.record.ownerSubjectHash !== expectedPrincipal ||
        (stored.record.ownerSubjectHash !== undefined && !/^[a-f0-9]{64}$/.test(stored.record.ownerSubjectHash))) return null;
    if (stored.record.expiresAt <= (this.options.now ?? Date.now)()) fail('file_expired', 'File reference has expired.');
    if (stored.record.scanReceipt !== undefined && !validBrowserFileScanReceipt(stored.record.scanReceipt, stored.record.sha256, stored.record.byteLength)) fail('file_integrity_failed', 'Stored scan receipt integrity check failed.');
    if (stored.record.byteLength !== stored.body.byteLength || createHash('sha256').update(stored.body).digest('hex') !== stored.record.sha256) {
      fail('file_integrity_failed', 'Stored file integrity check failed.');
    }
    return stored;
  }

  private storageKey(owner: string, id: string): string {
    return `browser-files/${owner}/${id}`;
  }
}

import { createHash } from 'node:crypto';
import { CloudBrowserError } from './contract.js';
import type { CloudBrowserCdp } from './actions.js';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_ID_LENGTH = 256;
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Uint8Array.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export type BrowserCaptureRequest =
  | { type: 'screenshot'; format?: 'png' | 'jpeg' }
  | { type: 'pdf'; landscape?: boolean; printBackground?: boolean };

export interface BrowserCapturedArtifact {
  contentType: 'image/png' | 'image/jpeg' | 'application/pdf';
  body: Uint8Array;
  sha256: string;
  /** Present only when the trusted PDF validator has verified the page tree. */
  pageCount?: number;
}

export interface BrowserCaptureValidationResult {
  complete: boolean;
  /** Required for PDFs and must come from structural page-tree validation. */
  pageCount?: number;
}

/** Trusted internal adapter, never a caller supplied browser/tool parameter. */
export type BrowserCaptureValidator = (input: Pick<BrowserCapturedArtifact, 'contentType' | 'body'>) =>
  BrowserCaptureValidationResult | Promise<BrowserCaptureValidationResult>;

function invalidCapture(): CloudBrowserError {
  return new CloudBrowserError('invalid_capture', 'Browser capture request or response is invalid.');
}

function captureFailed(): CloudBrowserError {
  return new CloudBrowserError('capture_failed', 'The browser capture could not be completed.');
}

function verificationFailed(): CloudBrowserError {
  return new CloudBrowserError('capture_verification_failed', 'The browser capture could not be verified as complete.');
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function validateRequest(input: BrowserCaptureRequest): BrowserCaptureRequest {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalidCapture();
  const request = input as unknown as Record<string, unknown>;
  if (request.type === 'screenshot') {
    if (!hasOnlyKeys(request, ['type', 'format']) || (request.format !== undefined && request.format !== 'png' && request.format !== 'jpeg')) throw invalidCapture();
    return { type: 'screenshot', ...(request.format === undefined ? {} : { format: request.format }) } as BrowserCaptureRequest;
  }
  if (request.type === 'pdf') {
    if (!hasOnlyKeys(request, ['type', 'landscape', 'printBackground']) ||
        (request.landscape !== undefined && typeof request.landscape !== 'boolean') ||
        (request.printBackground !== undefined && typeof request.printBackground !== 'boolean')) throw invalidCapture();
    return {
      type: 'pdf',
      ...(request.landscape === undefined ? {} : { landscape: request.landscape }),
      ...(request.printBackground === undefined ? {} : { printBackground: request.printBackground }),
    };
  }
  throw invalidCapture();
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_CAPTURE_BYTES / 3) * 4) throw invalidCapture();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalidCapture();

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = value.length / 4 * 3 - padding;
  if (decodedLength <= 0 || decodedLength > MAX_CAPTURE_BYTES) throw invalidCapture();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== decodedLength || decoded.toString('base64') !== value) throw invalidCapture();
  return Uint8Array.from(decoded);
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

function endsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  const offset = bytes.length - signature.length;
  return offset >= 0 && signature.every((byte, index) => bytes[offset + index] === byte);
}

function isCompletePdf(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const header = String.fromCharCode(...bytes.subarray(0, 8));
  if (!/^%PDF-(?:1\.[0-7]|2\.0)$/.test(header)) return false;
  const text = Buffer.from(bytes).toString('latin1').trimEnd();
  return text.endsWith('%%EOF');
}

function verifyFormat(bytes: Uint8Array, request: BrowserCaptureRequest): BrowserCapturedArtifact['contentType'] {
  if (request.type === 'pdf') {
    if (!isCompletePdf(bytes)) throw invalidCapture();
    return 'application/pdf';
  }
  if (request.format === 'jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || !endsWith(bytes, Uint8Array.of(0xff, 0xd9))) throw invalidCapture();
    return 'image/jpeg';
  }
  if (!startsWith(bytes, PNG_SIGNATURE) || !endsWith(bytes, PNG_IEND)) throw invalidCapture();
  return 'image/png';
}

/** Capture only bounded screenshot/PDF data using the two fixed CDP operations. */
export async function captureBrowserArtifact(
  cdp: CloudBrowserCdp,
  page: string,
  input: BrowserCaptureRequest,
  remaining: () => number,
  validator?: BrowserCaptureValidator,
): Promise<BrowserCapturedArtifact> {
  const request = validateRequest(input);
  if (typeof page !== 'string' || page.length === 0 || page.length > MAX_PAGE_ID_LENGTH || /[\u0000-\u001f]/.test(page)) throw invalidCapture();
  if (typeof validator !== 'function') throw new CloudBrowserError('capture_verifier_unavailable', 'Browser capture validation is unavailable.');

  let timeout: number;
  try { timeout = remaining(); } catch { throw captureFailed(); }
  if (!Number.isFinite(timeout) || timeout <= 0) throw new CloudBrowserError('capture_timeout', 'Browser capture deadline has expired.');

  const method = request.type === 'screenshot' ? 'Page.captureScreenshot' : 'Page.printToPDF';
  const params: Record<string, unknown> = request.type === 'screenshot'
    ? { format: request.format ?? 'png', fromSurface: true, captureBeyondViewport: true }
    : { landscape: request.landscape ?? false, printBackground: request.printBackground ?? false, transferMode: 'ReturnAsBase64' };

  let response: Record<string, unknown>;
  try { response = await cdp.command(method, params, timeout, page); }
  catch { throw captureFailed(); }

  let body: Uint8Array;
  try { body = decodeBase64(response.data); }
  catch { throw invalidCapture(); }
  const contentType = verifyFormat(body, request);
  let pageCount: number | undefined;
  try {
    const validation = await validator({ contentType, body: Uint8Array.from(body) });
    if (validation === null || typeof validation !== 'object' || !hasOnlyKeys(validation as unknown as Record<string, unknown>, ['complete', 'pageCount']) || validation.complete !== true) throw verificationFailed();
    if (contentType === 'application/pdf') {
      if (!Number.isSafeInteger(validation.pageCount) || validation.pageCount! < 1 || validation.pageCount! > 100) throw verificationFailed();
      pageCount = validation.pageCount;
    } else if (validation.pageCount !== undefined) {
      throw verificationFailed();
    }
  } catch { throw verificationFailed(); }
  const sha256 = createHash('sha256').update(body).digest('hex');
  return { contentType, body, sha256, ...(pageCount === undefined ? {} : { pageCount }) };
}

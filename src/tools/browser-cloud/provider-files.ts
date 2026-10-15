import { createHash } from 'node:crypto';
import { BROWSER_FILE_MAX_BYTES, type BrowserFileRecord } from './file-broker.js';
import { CloudBrowserError, type CloudBrowserSession } from './contract.js';

const CHUNK_BYTES = 1024 * 1024;
const MAX_TRANSFER_MS = 20_000;
const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'text/csv': ['csv'],
  'text/plain': ['txt'],
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
};

type FileCdpMethod = 'DOM.enable' | 'DOM.getDocument' | 'DOM.performSearch' | 'DOM.getSearchResults' | 'DOM.describeNode' | 'DOM.resolveNode' |
  'DOM.discardSearchResults' | 'Runtime.callFunctionOn' | 'Runtime.releaseObject';

/** The only provider protocol surface this adapter needs; callers cannot supply CDP method names. */
export interface BrowserFileCdp {
  command(method: FileCdpMethod, params: Record<string, unknown>, timeoutMs: number, sessionId?: string): Promise<Record<string, unknown>>;
}

export type BrowserFileTransferReceipt = {
  /** Means selected on the owned file input and verified after input/change events were dispatched. */
  status: 'attached';
  filename: string;
  contentType: string;
  byteLength: number;
  /** SHA-256 of the browser-side File bytes read back after change handlers ran. */
  sha256: string;
};

/** Trusted server-only resolver backed by BrowserFileBroker.forUpload. */
export type BrowserFileResolver = (owner: string, fileId: string) => Promise<{ record: BrowserFileRecord; body: Uint8Array }>;

export type AttachStagedFileInput = {
  caller: string;
  session: CloudBrowserSession;
  targetId: string;
  /** Obtained by the trusted transport after attaching to the owned target. */
  pageSessionId: string;
  selector: string;
  file: { record: BrowserFileRecord; body: Uint8Array };
  cdp: BrowserFileCdp;
  timeoutMs: number;
  now?: () => number;
};

function fail(code: string, message: string): never {
  throw new CloudBrowserError(code, message);
}

function validFilename(name: string, contentType: string): boolean {
  if (name.length < 1 || name.length > 128 || name.startsWith('.') || name.endsWith('.') || name.endsWith(' ') || name.includes('..')) return false;
  if (!/^[a-z0-9][a-z0-9._ -]*$/i.test(name) || /[\\/\u0000-\u001f\u007f]/.test(name)) return false;
  return Boolean(MIME_EXTENSIONS[contentType]?.includes(name.split('.').at(-1)?.toLowerCase() ?? ''));
}

function acceptedByInput(accept: string | undefined, filename: string, contentType: string): boolean {
  if (!accept?.trim()) return true;
  const extension = `.${filename.split('.').at(-1)?.toLowerCase() ?? ''}`;
  const [kind] = contentType.split('/');
  return accept.split(',').some((entry) => {
    const token = entry.trim().toLowerCase();
    return token === extension || token === contentType || token === `${kind}/*`;
  });
}

function assertReadyFile(file: AttachStagedFileInput['file'], caller: string, now: number): void {
  const { record, body } = file;
  if (!record || record.owner !== caller) fail('owner_forbidden', 'File is unavailable to this caller.');
  if (record.status !== 'ready') fail('file_not_ready', 'File is not cleared for browser transfer.');
  if (!validFilename(record.filename, record.contentType) || !(body instanceof Uint8Array) || body.byteLength < 1 || body.byteLength > BROWSER_FILE_MAX_BYTES) {
    fail('invalid_file', 'Staged file metadata or size is invalid.');
  }
  if (!Number.isSafeInteger(record.byteLength) || record.byteLength !== body.byteLength || !/^[a-f0-9]{64}$/.test(record.sha256) ||
      createHash('sha256').update(body).digest('hex') !== record.sha256) {
    fail('file_integrity_failed', 'Staged file integrity check failed.');
  }
  if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now) fail('file_expired', 'Staged file has expired.');
}

function value(result: Record<string, unknown>): Record<string, unknown> {
  if (result.exceptionDetails) fail('file_transfer_failed', 'Browser file transfer could not be completed.');
  const remote = result.result;
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) fail('file_transfer_failed', 'Browser file transfer could not be completed.');
  return remote as Record<string, unknown>;
}

/**
 * Attach already validated broker bytes to exactly one file input on the currently selected,
 * owned page. Directory inputs are unsupported: a synthetic File cannot preserve their native
 * relative paths. It uses fixed, server-authored Runtime.callFunctionOn bodies; no caller
 * JavaScript or remote path is accepted. The receipt proves only file-input selection, never site upload.
 */
export async function attachStagedFileToOwnedInput(input: AttachStagedFileInput): Promise<BrowserFileTransferReceipt> {
  const now = input.now ?? Date.now;
  if (input.caller !== input.session.owner) fail('owner_forbidden', 'Browser session is unavailable to this caller.');
  if (!Number.isSafeInteger(input.session.expiresAt) || input.session.expiresAt <= now()) fail('session_expired', 'Browser session has expired.');
  if (!input.session.ownedTargetIds?.includes(input.targetId) || input.session.selectedTargetId !== input.targetId) {
    fail('target_not_owned', 'File transfer requires the selected owned browser tab.');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.pageSessionId) || typeof input.selector !== 'string' || input.selector.length < 1 || input.selector.length > 256 || /[\u0000-\u001f\u007f]/.test(input.selector)) {
    fail('invalid_file_target', 'Browser file input reference is invalid.');
  }
  assertReadyFile(input.file, input.caller, now());
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) fail('provider_timeout', 'Browser file transfer exceeded its deadline.');
  const budget = Math.min(Math.floor(input.timeoutMs), MAX_TRANSFER_MS);
  const deadline = Date.now() + budget;
  const remaining = (): number => {
    const ms = deadline - Date.now();
    if (ms <= 0) fail('provider_timeout', 'Browser file transfer exceeded its deadline.');
    return ms;
  };
  const command = (method: FileCdpMethod, params: Record<string, unknown>) => input.cdp.command(method, params, remaining(), input.pageSessionId);
  let searchId: string | undefined;
  let inputObjectId: string | undefined;
  let partsObjectId: string | undefined;
  let fileObjectId: string | undefined;
  let assignmentAttempted = false;
  try {
    await command('DOM.enable', {});
    await command('DOM.getDocument', { depth: 0 });
    const search = await command('DOM.performSearch', { query: input.selector, includeUserAgentShadowDOM: false });
    if (typeof search.searchId === 'string') searchId = search.searchId;
    if (!searchId || search.resultCount !== 1) fail('file_input_ambiguous', 'Selector must match exactly one browser file input.');
    const found = await command('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: 1 });
    const nodeId = Array.isArray(found.nodeIds) && found.nodeIds.length === 1 ? found.nodeIds[0] : undefined;
    if (!Number.isSafeInteger(nodeId) || (nodeId as number) <= 0) fail('file_input_missing', 'Browser file input is unavailable.');
    const described = await command('DOM.describeNode', { nodeId, depth: 1, pierce: false });
    const node = described.node as { nodeName?: unknown; attributes?: unknown } | undefined;
    const attributes = Array.isArray(node?.attributes) ? node.attributes as unknown[] : [];
    let inputType: unknown;
    let accept: string | undefined;
    let disabled = false;
    let directory = false;
    for (let i = 0; i + 1 < attributes.length; i += 2) {
      if (attributes[i] === 'type') inputType = attributes[i + 1];
      if (attributes[i] === 'accept' && typeof attributes[i + 1] === 'string') accept = attributes[i + 1] as string;
      if (attributes[i] === 'disabled') disabled = true;
      if (attributes[i] === 'webkitdirectory') directory = true;
    }
    if (node?.nodeName !== 'INPUT' || String(inputType).toLowerCase() !== 'file' || disabled) fail('file_input_invalid', 'Target must be one enabled file input.');
    if (directory) fail('directory_input_unsupported', 'Directory inputs require native folder transfer and are not supported by single-file attachment.');
    if (!acceptedByInput(accept, input.file.record.filename, input.file.record.contentType)) fail('file_input_type_rejected', 'File type is not accepted by the selected input.');
    const resolved = await command('DOM.resolveNode', { nodeId });
    const object = resolved.object as { objectId?: unknown } | undefined;
    if (typeof object?.objectId !== 'string' || !object.objectId) fail('file_input_invalid', 'Browser file input could not be resolved.');
    inputObjectId = object.objectId;

    const typeCheck = value(await command('Runtime.callFunctionOn', {
      objectId: inputObjectId,
      functionDeclaration: 'function(){ return this instanceof HTMLInputElement && this.type === "file" && this.isConnected && !this.disabled && !this.webkitdirectory && !this.hasAttribute("webkitdirectory"); }',
      returnByValue: true,
      awaitPromise: false,
      userGesture: false,
    }));
    if (typeCheck.value !== true) fail('file_input_invalid', 'Target must remain an enabled file input.');

    const allocated = value(await command('Runtime.callFunctionOn', {
      objectId: inputObjectId,
      functionDeclaration: 'function(){ return []; }',
      returnByValue: false,
      awaitPromise: false,
      userGesture: false,
    }));
    if (typeof allocated.objectId !== 'string' || !allocated.objectId) fail('file_transfer_failed', 'Browser file transfer could not be initialized.');
    partsObjectId = allocated.objectId;
    for (let offset = 0; offset < input.file.body.byteLength; offset += CHUNK_BYTES) {
      const base64 = Buffer.from(input.file.body.subarray(offset, Math.min(offset + CHUNK_BYTES, input.file.body.byteLength))).toString('base64');
      const appended = value(await command('Runtime.callFunctionOn', {
        objectId: partsObjectId,
        functionDeclaration: 'function(encoded){ const raw = atob(encoded); const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); this.push(bytes); return this.length; }',
        arguments: [{ value: base64 }],
        returnByValue: true,
        awaitPromise: false,
        userGesture: false,
      }));
      if (appended.value !== Math.floor(offset / CHUNK_BYTES) + 1) fail('file_transfer_failed', 'Browser file transfer could not be completed.');
    }

    assignmentAttempted = true;
    const assigned = value(await command('Runtime.callFunctionOn', {
      objectId: inputObjectId,
      functionDeclaration: 'function(parts,name,type){ if (!(this instanceof HTMLInputElement) || this.type !== "file" || !this.isConnected || this.disabled || this.webkitdirectory || this.hasAttribute("webkitdirectory")) return false; const file = new File(parts,name,{type,lastModified:0}); const transfer = new DataTransfer(); transfer.items.add(file); this.files = transfer.files; this.dispatchEvent(new Event("input",{bubbles:true})); this.dispatchEvent(new Event("change",{bubbles:true})); return true; }',
      arguments: [{ objectId: partsObjectId }, { value: input.file.record.filename }, { value: input.file.record.contentType }],
      returnByValue: true,
      awaitPromise: false,
      userGesture: false,
    }));
    if (assigned.value !== true) fail('file_transfer_failed', 'Browser file input rejected the staged file.');
    const selectedFile = value(await command('Runtime.callFunctionOn', {
      objectId: inputObjectId,
      functionDeclaration: 'function(){ const f=this.files && this.files[0]; return f || null; }',
      returnByValue: false,
      awaitPromise: false,
      userGesture: false,
    }));
    if (typeof selectedFile.objectId !== 'string' || !selectedFile.objectId) fail('file_readback_failed', 'Browser file input did not retain the staged file.');
    fileObjectId = selectedFile.objectId;
    const readback = value(await command('Runtime.callFunctionOn', {
      objectId: fileObjectId,
      functionDeclaration: 'function(){ return { name:this.name, size:this.size, type:this.type }; }',
      returnByValue: true,
      awaitPromise: false,
      userGesture: false,
    }));
    if (readback.value === null || typeof readback.value !== 'object') fail('file_readback_failed', 'Browser file input did not retain the staged file.');
    const actual = readback.value as Record<string, unknown>;
    if (actual.name !== input.file.record.filename || actual.size !== input.file.record.byteLength || actual.type !== input.file.record.contentType) {
      fail('file_readback_failed', 'Browser file input did not retain the staged file.');
    }
    const actualHash = createHash('sha256');
    for (let offset = 0; offset < input.file.record.byteLength; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, input.file.record.byteLength - offset);
      const chunk = value(await command('Runtime.callFunctionOn', {
        objectId: fileObjectId,
        functionDeclaration: 'function(offset,length){ return this.slice(offset,offset+length).arrayBuffer().then(buffer=>{ const bytes=new Uint8Array(buffer); const pieces=[]; for(let i=0;i<bytes.length;i+=8192) pieces.push(String.fromCharCode(...bytes.subarray(i,i+8192))); return { offset, base64:btoa(pieces.join("")) }; }); }',
        arguments: [{ value: offset }, { value: length }],
        returnByValue: true,
        awaitPromise: true,
        userGesture: false,
      }));
      if (!chunk.value || typeof chunk.value !== 'object') fail('file_readback_failed', 'Browser file input did not retain the staged bytes.');
      const part = chunk.value as Record<string, unknown>;
      if (part.offset !== offset || typeof part.base64 !== 'string') fail('file_readback_failed', 'Browser file input did not retain the staged bytes.');
      const bytes = Buffer.from(part.base64, 'base64');
      if (bytes.byteLength !== length || bytes.toString('base64') !== part.base64) fail('file_readback_failed', 'Browser file input did not retain the staged bytes.');
      actualHash.update(bytes);
    }
    if (actualHash.digest('hex') !== input.file.record.sha256) fail('file_readback_failed', 'Browser file input did not retain the staged bytes.');
    return { status: 'attached', filename: input.file.record.filename, contentType: input.file.record.contentType, byteLength: input.file.record.byteLength, sha256: input.file.record.sha256 };
  } catch (error) {
    if (error instanceof CloudBrowserError) {
      if (assignmentAttempted && error.code !== 'file_transfer_uncertain') fail('file_transfer_uncertain', 'File input assignment may have occurred; inspect the owned page before retrying.');
      throw error;
    }
    return fail(assignmentAttempted ? 'file_transfer_uncertain' : 'file_transfer_failed', assignmentAttempted
      ? 'File input assignment may have occurred; inspect the owned page before retrying.'
      : 'Browser file transfer could not be completed.');
  } finally {
    if (partsObjectId) void input.cdp.command('Runtime.releaseObject', { objectId: partsObjectId }, 1_000, input.pageSessionId).catch(() => undefined);
    if (inputObjectId) void input.cdp.command('Runtime.releaseObject', { objectId: inputObjectId }, 1_000, input.pageSessionId).catch(() => undefined);
    if (fileObjectId) void input.cdp.command('Runtime.releaseObject', { objectId: fileObjectId }, 1_000, input.pageSessionId).catch(() => undefined);
    if (searchId) void input.cdp.command('DOM.discardSearchResults', { searchId }, 1_000, input.pageSessionId).catch(() => undefined);
  }
}

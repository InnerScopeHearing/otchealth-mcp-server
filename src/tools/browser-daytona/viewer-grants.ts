import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { DaytonaViewerGrantPort } from './client.js';
import { DaytonaBrowserError, type DaytonaBinding } from './contract.js';
import { assertDaytonaBinding } from './store.js';
import { assertDaytonaViewerGrantRecord, daytonaViewerGrantBindingHash, daytonaViewerPhysicalScopeHash, type DaytonaViewerGrantRecord, type DaytonaViewerGrantStore } from './viewer-grant-store.js';

export interface EncryptedDaytonaViewerGrantOptions {
  store: DaytonaViewerGrantStore;
  apiBaseUrl: string;
  organizationId: string;
  resolveApiToken: () => Promise<string>;
  /** Dedicated high-entropy server-only 32-byte key. NEVER use an OAuth/signing secret. */
  encryptionKey: Uint8Array;
  /** Actual reviewed private preview and runtime receipts; no guessed VNC defaults. */
  previewDomain: string;
  previewPort: number;
  previewPath: string;
  viewerControlSha256: string;
  toolboxAllowedOrigins: readonly string[];
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
  now?: () => number;
}
type Context = { signal: AbortSignal; check: () => number; token?: string };
type Grant = { url: string; expiresAt: number; grantHandle: string };
type Secret = { url: string; token: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const TOKEN = /^[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$/;
function fail(code = 'daytona_viewer_unavailable'): never { throw new DaytonaBrowserError(code); }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
function https(raw: string): URL {
  let value: URL; try { value = new URL(raw); } catch { return fail(); }
  if (value.protocol !== 'https:' || value.port || value.username || value.password || value.search || value.hash) return fail(); return value;
}

/** Official SDK0.224.1 REST recipes, no resource starts and no automatic retries. */
export class EncryptedDaytonaViewerGrantPort implements DaytonaViewerGrantPort {
  private readonly key: Buffer;
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly deadline: number;
  private readonly origins: ReadonlySet<string>;
  constructor(private readonly options: EncryptedDaytonaViewerGrantOptions) {
    if (!UUID.test(options.organizationId) || !(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32
      || new Set(options.encryptionKey).size < 8 || !DOMAIN.test(options.previewDomain) || options.previewDomain.length > 200
      || !Number.isSafeInteger(options.previewPort) || options.previewPort < 1 || options.previewPort > 65535
      || !/^\/[A-Za-z0-9_./-]+$/.test(options.previewPath) || options.previewPath.includes('..') || !HASH.test(options.viewerControlSha256)
      || typeof options.resolveApiToken !== 'function' || !options.store || !Array.isArray(options.toolboxAllowedOrigins) || options.toolboxAllowedOrigins.length < 1 || options.toolboxAllowedOrigins.length > 4) fail();
    this.key = Buffer.from(options.encryptionKey); this.base = https(options.apiBaseUrl); this.base.pathname = this.base.pathname.replace(/\/+$/, '');
    this.origins = new Set(options.toolboxAllowedOrigins.map(raw => { const url = https(raw); if (url.pathname !== '/') fail(); return url.origin; }));
    this.fetcher = options.fetchImpl ?? fetch; this.now = options.now ?? Date.now; this.deadline = options.deadlineMs ?? 20000;
    if (!Number.isSafeInteger(this.deadline) || this.deadline < 1 || this.deadline > 20000) fail();
  }
  private async bounded<T>(run: (context: Context) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
    const abort = new AbortController(); const until = Date.now() + this.deadline;
    const signal = externalSignal ? AbortSignal.any([abort.signal, externalSignal]) : abort.signal;
    const context: Context = { signal, check: () => { const left = until - Date.now(); if (signal.aborted || left <= 0) return fail(); return left; } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new DaytonaBrowserError('daytona_viewer_unavailable')); }, this.deadline); });
    let onCancel: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => { onCancel = () => reject(new DaytonaBrowserError('daytona_viewer_unavailable')); if (signal.aborted) onCancel(); else signal.addEventListener('abort', onCancel, { once: true }); });
    try { return await Promise.race([Promise.resolve().then(() => { context.check(); return run(context); }), timeout, cancelled]); }
    // Never relay vendor, credential resolver, crypto or storage exception text.
    catch { return fail(); }
    finally { clearTimeout(timer); if (onCancel) signal.removeEventListener('abort', onCancel); abort.abort(); }
  }
  private bindingHash(binding: DaytonaBinding): string {
    return daytonaViewerGrantBindingHash(this.options.organizationId, binding);
  }
  private aad(binding: DaytonaBinding, value: DaytonaViewerGrantRecord): Buffer {
    return Buffer.from(JSON.stringify(['daytona-viewer-v2', value.version, this.options.organizationId, binding.sandboxId, binding.profileKey, binding.profilePath, binding.owner, binding.ownerSubjectHash, binding.readinessReceiptSha256, value.grantHandle, value.expiresAt]));
  }
  private seal(binding: DaytonaBinding, value: DaytonaViewerGrantRecord, secret: Secret): NonNullable<DaytonaViewerGrantRecord['sealed']> {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(this.aad(binding, value));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  }
  private unseal(binding: DaytonaBinding, value: DaytonaViewerGrantRecord): Secret {
    if (!value.sealed) fail();
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.sealed.iv, 'base64url'));
    decipher.setAAD(this.aad(binding, value)); decipher.setAuthTag(Buffer.from(value.sealed.tag, 'base64url'));
    const clear = Buffer.concat([decipher.update(Buffer.from(value.sealed.ciphertext, 'base64url')), decipher.final()]);
    const secret = record(JSON.parse(clear.toString('utf8'))); clear.fill(0);
    if (Object.keys(secret).length !== 2 || typeof secret.token !== 'string' || typeof secret.url !== 'string') return fail();
    this.validateSecret(secret.token, secret.url); return { token: secret.token, url: secret.url };
  }
  private validateSecret(token: string, raw: string): void {
    if (!TOKEN.test(token) || `${this.options.previewPort}-${token}`.length > 63) fail(); const url = https(raw);
    if (url.hostname !== `${this.options.previewPort}-${token}.${this.options.previewDomain}` || url.pathname !== this.options.previewPath) fail();
  }
  private async request(context: Context, url: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    context.check(); const headers = new Headers(init.headers);
    if (authenticated) {
      if (!context.token) { const token = await this.options.resolveApiToken(); context.check(); if (typeof token !== 'string' || token.length < 1 || token.length > 8192 || /[\r\n]/.test(token)) fail(); context.token = token; }
      headers.set('authorization', `Bearer ${context.token}`); headers.set('x-daytona-organization-id', this.options.organizationId); headers.set('content-type', 'application/json');
    }
    headers.set('cache-control', 'no-store');
    const response = await this.fetcher(url, { ...init, headers, signal: context.signal, redirect: 'manual', credentials: 'omit' }); context.check(); return response;
  }
  private async json(context: Context, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.request(context, url, init);
    if (response.status !== 200 || !response.body) { await response.body?.cancel().catch(() => undefined); return fail(); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { context.check(); const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 131072) { await reader.cancel(); fail(); } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
    context.check(); return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
  private async inspect(context: Context, binding: DaytonaBinding): Promise<void> {
    const state = await this.json(context, `${this.base.href}/sandbox/${encodeURIComponent(binding.sandboxId)}`);
    if (state.id !== binding.sandboxId || state.organizationId !== this.options.organizationId || state.public !== false || state.state !== 'started') fail();
  }
  private async previewStatus(context: Context, url: string): Promise<number> {
    // Unauthenticated and non-redirecting: the organization API key must NEVER
    // reach this signed viewer origin, even during negative revocation checks.
    const response = await this.request(context, url, { headers: { 'x-daytona-skip-preview-warning': 'true' } }, false);
    const status = response.status; await response.body?.cancel().catch(() => undefined); context.check(); return status;
  }
  private async owned(context: Context, binding: DaytonaBinding, handle: string): Promise<DaytonaViewerGrantRecord> {
    assertDaytonaBinding(binding); if (!UUID.test(handle)) fail();
    const value = await this.options.store.load(handle, context.signal); context.check(); assertDaytonaViewerGrantRecord(value);
    if (value.grantHandle !== handle || value.organizationId !== this.options.organizationId || value.bindingHash !== this.bindingHash(binding) || value.scopeHash !== daytonaViewerPhysicalScopeHash(this.options.organizationId, binding.sandboxId)) fail(); return value;
  }
  async mint(binding: DaytonaBinding, expiresSeconds: number): Promise<Grant> {
    return this.bounded(async context => {
      assertDaytonaBinding(binding); if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 300) fail();
      await this.inspect(context, binding); context.check();
      const value: DaytonaViewerGrantRecord = { version: 2, organizationId: this.options.organizationId, binding: structuredClone(binding), grantHandle: randomUUID(), bindingHash: this.bindingHash(binding), scopeHash: daytonaViewerPhysicalScopeHash(this.options.organizationId, binding.sandboxId), expiresAt: this.now() + expiresSeconds * 1000, phase: 'MINTING' };
      if (!await this.options.store.reserve(value, context.signal)) fail(); context.check();
      // SDK0.224.1 SandboxApi.get_signed_port_preview_url (effectful GET).
      const result = await this.json(context, `${this.base.href}/sandbox/${encodeURIComponent(binding.sandboxId)}/ports/${this.options.previewPort}/signed-preview-url?expiresInSeconds=${expiresSeconds}`);
      if (result.sandboxId !== binding.sandboxId || result.port !== this.options.previewPort || typeof result.token !== 'string' || typeof result.url !== 'string') fail();
      const root = https(result.url); if (root.pathname !== '/') fail();
      const url = new URL(this.options.previewPath, root.origin).href; this.validateSecret(result.token, url);
      // Require a usable pre-revocation baseline, not a pre-existing upstream
      // 401 that could later be mistaken for successful token revocation.
      if (await this.previewStatus(context, url) !== 200 || value.expiresAt <= this.now()) fail();
      const active: DaytonaViewerGrantRecord = { ...value, phase: 'ACTIVE', sealed: this.seal(binding, value, { token: result.token, url }) };
      context.check(); if (!await this.options.store.compareAndSwap(value, active, context.signal)) fail(); context.check();
      return { url, expiresAt: value.expiresAt, grantHandle: value.grantHandle };
    });
  }
  async read(binding: DaytonaBinding, handle: string): Promise<Grant> {
    return this.bounded(async context => { const value = await this.owned(context, binding, handle); if (value.phase !== 'ACTIVE' || value.expiresAt <= this.now()) fail(); const secret = this.unseal(binding, value); context.check(); return { url: secret.url, expiresAt: value.expiresAt, grantHandle: handle }; });
  }
  private async disconnect(context: Context, binding: DaytonaBinding): Promise<void> {
    const proxy = await this.json(context, `${this.base.href}/sandbox/${encodeURIComponent(binding.sandboxId)}/toolbox-proxy-url`);
    if (typeof proxy.url !== 'string') fail(); const base = https(proxy.url); if (!this.origins.has(base.origin)) fail();
    // Hash and execute the SAME bytes, avoiding a check/use path replacement.
    // No caller-provided PID, display, shell, profile or command is accepted.
    const python = `import hashlib,pathlib,sys;p=pathlib.Path("/opt/otchealth-browser/viewer_control.py");code=p.read_bytes();sys.exit(1) if hashlib.sha256(code).hexdigest()!="${this.options.viewerControlSha256}" else None;sys.argv=[str(p),"disconnect"];exec(compile(code,str(p),"exec"),{"__name__":"__main__","__file__":str(p)})`;
    const seconds = Math.min(12, Math.floor((context.check() - 2000) / 1000)); if (seconds < 1) fail();
    const response = await this.json(context, `${base.href.replace(/\/+$/, '')}/${encodeURIComponent(binding.sandboxId)}/process/execute`, { method: 'POST', body: JSON.stringify({ command: `sudo -n python3 -I -c '${python}'`, timeout: seconds }) });
    if ((response.exitCode ?? response.code) !== 0 || typeof response.result !== 'string' || response.result.length > 4096) fail();
    const receipt = record(JSON.parse(response.result));
    if (Object.keys(receipt).some(key => !['human_input_revoked', 'display', 'active_clients', 'x11vnc_pid'].includes(key)) || receipt.human_input_revoked !== true || receipt.display !== ':0' || receipt.active_clients !== 0 || !Number.isSafeInteger(receipt.x11vnc_pid) || Number(receipt.x11vnc_pid) < 1) fail();
  }
  async revoke(binding: DaytonaBinding, handle: string, signal?: AbortSignal): Promise<{ human_input_revoked: true }> {
    return this.bounded(async context => {
      const before = await this.owned(context, binding, handle);
      if (before.phase === 'REVOKED') return { human_input_revoked: true };
      if (before.phase !== 'ACTIVE') fail(); const secret = this.unseal(binding, before);
      const revoking: DaytonaViewerGrantRecord = { ...before, phase: 'REVOKING' };
      if (!await this.options.store.compareAndSwap(before, revoking, context.signal)) fail(); context.check();
      await this.inspect(context, binding);
      // SDK0.224.1 SandboxApi.expire_signed_port_preview_url: exact 200 ACK.
      const response = await this.request(context, `${this.base.href}/sandbox/${encodeURIComponent(binding.sandboxId)}/ports/${this.options.previewPort}/signed-preview-url/${encodeURIComponent(secret.token)}/expire`, { method: 'POST' });
      await response.body?.cancel().catch(() => undefined); if (response.status !== 200) fail(); context.check();
      const denied = await this.previewStatus(context, secret.url); if (denied !== 401 && denied !== 403) fail();
      await this.disconnect(context, binding); context.check();
      const revoked: DaytonaViewerGrantRecord = { version: 2, organizationId: before.organizationId, binding: before.binding, grantHandle: before.grantHandle, bindingHash: before.bindingHash, scopeHash: before.scopeHash, expiresAt: before.expiresAt, phase: 'REVOKED' };
      if (!await this.options.store.compareAndSwap(revoking, revoked, context.signal)) fail(); context.check();
      return { human_input_revoked: true };
    }, signal);
  }
}

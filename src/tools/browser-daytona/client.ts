import type { CloudBrowserAction, CloudBrowserExecutionResult } from '../browser-cloud/contract.js';
import type { BrowserPageReceipt } from '../browser-cloud/page-controls.js';
import { validateCloudBrowserAction } from '../browser-cloud/actions.js';
import { DaytonaBrowserError, type DaytonaBinding, type DaytonaMission, type DaytonaProvider } from './contract.js';
import { assertDaytonaBinding, assertDaytonaMission } from './store.js';

type ViewerGrant = { url: string; expiresAt: number; grantHandle: string };
/** Trusted server-only vault. Revoke must include actual native VNC disconnection proof. */
export interface DaytonaViewerGrantPort {
  mint(binding: DaytonaBinding, expiresSeconds: number): Promise<ViewerGrant>;
  read(binding: DaytonaBinding, grantHandle: string): Promise<ViewerGrant>;
  revoke(binding: DaytonaBinding, grantHandle: string): Promise<{ human_input_revoked: true }>;
}
export interface DaytonaApiBrowserProviderOptions {
  apiBaseUrl: string;
  organizationId: string;
  resolveApiToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Exact server-configured proxy origins; defaults to the configured API origin only. */
  toolboxAllowedOrigins?: readonly string[];
  deadlineMs?: number;
  viewer?: DaytonaViewerGrantPort;
}
type Context = { signal: AbortSignal; remaining: () => number; token?: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (code: string): never => { throw new DaytonaBrowserError(code); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('daytona_provider_invalid');
function httpsUrl(raw: string): URL {
  let url: URL; try { url = new URL(raw); } catch { return fail('daytona_provider_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) return fail('daytona_provider_invalid');
  return url;
}

/** No provisioning methods. Each operation uses the exact approved enrollment and one absolute deadline. */
export class DaytonaApiBrowserProvider implements DaytonaProvider {
  readonly capabilities = Object.freeze({ typedBrowser: true, upload: false, capture: false, checkpoint: false, publicWebNetworkIsolation: false,
    actions: Object.freeze(['navigate', 'snapshot', 'click', 'type', 'focus', 'select', 'wait_for', 'press_key', 'scroll', 'mouse_move', 'drag', 'tab_create', 'tab_select', 'tab_close', 'navigate_back', 'navigate_forward', 'reload', 'dialog']), maxActionSeconds: 14 });
  private readonly base: URL;
  private readonly origins: ReadonlySet<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly deadlineMs: number;
  constructor(private readonly options: DaytonaApiBrowserProviderOptions) {
    if (!UUID.test(options.organizationId)) fail('daytona_provider_invalid');
    this.base = httpsUrl(options.apiBaseUrl); this.base.pathname = this.base.pathname.replace(/\/+$/, '');
    this.origins = new Set([this.base.origin, ...(options.toolboxAllowedOrigins ?? []).map(raw => {
      const url = httpsUrl(raw); if (url.pathname !== '/') return fail('daytona_provider_invalid'); return url.origin;
    })]);
    this.fetchImpl = options.fetchImpl ?? fetch; this.deadlineMs = options.deadlineMs ?? 20000;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > 20000 || typeof options.resolveApiToken !== 'function') fail('daytona_provider_invalid');
  }
  private async bounded<T>(run: (context: Context) => Promise<T>): Promise<T> {
    const abort = new AbortController(); const until = Date.now() + this.deadlineMs;
    const context: Context = { signal: abort.signal, remaining: () => { const ms = until - Date.now(); if (abort.signal.aborted || ms <= 0) return fail('daytona_provider_timeout'); return ms; } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new DaytonaBrowserError('daytona_provider_timeout')); }, this.deadlineMs); });
    try { return await Promise.race([run(context), timeout]); }
    catch (error) { if (error instanceof DaytonaBrowserError) throw error; return fail(abort.signal.aborted ? 'daytona_provider_timeout' : 'daytona_provider_unavailable'); }
    finally { clearTimeout(timer); }
  }
  private async json(context: Context, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    context.remaining(); if (!context.token) {
      const token = await this.options.resolveApiToken(); context.remaining();
      if (typeof token !== 'string' || token.length < 1 || token.length > 8192 || /[\r\n]/.test(token)) return fail('daytona_credentials_unavailable');
      context.token = token;
    }
    const response = await this.fetchImpl(url, { ...init, headers: { authorization: `Bearer ${context.token}`, 'content-type': 'application/json' }, signal: context.signal, redirect: 'error' });
    context.remaining(); if (!response.ok) { await response.body?.cancel().catch(() => undefined); return fail('daytona_provider_unavailable'); }
    if (!response.body) return fail('daytona_provider_invalid');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) { context.remaining(); const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > 131072) { await reader.cancel(); return fail('daytona_provider_invalid'); } chunks.push(next.value); }
      context.remaining(); let parsed: unknown; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail('daytona_provider_invalid'); } return record(parsed);
    } finally { reader.releaseLock(); }
  }
  private async inspectWith(context: Context, binding: DaytonaBinding): Promise<{ sandboxId: string; state: 'started' | 'stopped' | 'other'; public: boolean }> {
    const result = await this.json(context, `${this.base.href}/sandbox/${encodeURIComponent(binding.sandboxId)}`);
    if (result.id !== binding.sandboxId || result.organizationId !== this.options.organizationId || typeof result.public !== 'boolean' || typeof result.state !== 'string') return fail('daytona_provider_invalid');
    return { sandboxId: binding.sandboxId, state: result.state === 'started' ? 'started' : result.state === 'stopped' ? 'stopped' : 'other', public: result.public };
  }
  async inspect(binding: DaytonaBinding): Promise<{ sandboxId: string; state: 'started' | 'stopped' | 'other'; public: boolean }> {
    assertDaytonaBinding(binding); return this.bounded(context => this.inspectWith(context, binding));
  }
  private async runtime(binding: DaytonaBinding, op: 'probe' | 'open' | 'execute' | 'release', sessionId?: string, action?: CloudBrowserAction, principalHash?: string, timeoutSeconds = 18): Promise<unknown> {
    assertDaytonaBinding(binding); if (sessionId !== undefined && !UUID.test(sessionId)) return fail('owner_forbidden');
    return this.bounded(async context => {
      const state = await this.inspectWith(context, binding); if (state.state !== 'started' || state.public !== false) return fail('daytona_not_ready');
      const proxy = await this.json(context, `${this.base.href}/sandbox/${encodeURIComponent(binding.sandboxId)}/toolbox-proxy-url`);
      if (typeof proxy.url !== 'string') return fail('daytona_provider_invalid'); const base = httpsUrl(proxy.url);
      if (!this.origins.has(base.origin)) return fail('daytona_toolbox_origin_forbidden');
      // Official execute timeout is seconds; retain five seconds for its terminal receipt.
      const timeoutMs = Math.min(14000, timeoutSeconds * 1000, context.remaining() - 5000); if (timeoutMs < 1000) return fail('daytona_provider_timeout');
      const payload = { version: 1, op, profileKey: binding.profileKey, profilePath: binding.profilePath, timeoutMs: Math.floor(timeoutMs), ...(sessionId ? { sessionId } : {}), ...(action ? { action } : {}), principalHash: principalHash ?? binding.ownerSubjectHash };
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const command = `runuser -u otcbrowser -- python3 /opt/otchealth-browser/browser-dispatcher.py --payload ${encoded}`;
      const response = await this.json(context, `${base.href.replace(/\/+$/, '')}/${encodeURIComponent(binding.sandboxId)}/process/execute`, { method: 'POST', body: JSON.stringify({ command, timeout: Math.ceil(timeoutMs / 1000) }) });
      if ((response.exitCode ?? response.code) !== 0 || typeof response.result !== 'string' || response.result.length > 100000) return fail('daytona_runtime_unavailable');
      let parsed: unknown; try { parsed = JSON.parse(response.result); } catch { return fail('daytona_runtime_invalid'); } const receipt = record(parsed);
      if (receipt.version !== 1 || receipt.ok !== true || receipt.profileKey !== binding.profileKey || receipt.profilePath !== binding.profilePath || (sessionId !== undefined && receipt.sessionId !== sessionId)) return fail('daytona_runtime_invalid');
      const result = record(receipt.result);
      if ((op === 'probe' || op === 'open') && (result.ready !== true || result.cdpLoopback !== true || result.profileVerified !== true)) return fail('daytona_runtime_unavailable');
      if (op === 'release' && result.released !== true) return fail('daytona_runtime_invalid');
      return result;
    });
  }
  /** Read-only local runtime readiness, never browser/resource launch. */
  async probe(binding: DaytonaBinding): Promise<void> { await this.runtime(binding, 'probe'); }
  async openMission(binding: DaytonaBinding, logicalSessionId: string): Promise<void> { await this.runtime(binding, 'open', logicalSessionId); }
  async execute(binding: DaytonaBinding, session: DaytonaMission, action: CloudBrowserAction, timeoutSeconds: number, principalHash: string): Promise<CloudBrowserExecutionResult> {
    assertDaytonaBinding(binding); assertDaytonaMission(session);
    if (session.sandboxId !== binding.sandboxId || session.profileKey !== binding.profileKey || session.owner !== binding.owner || session.ownerSubjectHash !== binding.ownerSubjectHash || principalHash !== binding.ownerSubjectHash || session.phase !== 'ACTIVE' || session.sensitiveOutputSuppressed || session.expiresAt <= Date.now()) return fail('owner_forbidden');
    const checked = validateCloudBrowserAction(action);
    if (checked.type === 'upload' || checked.type === 'capture') return fail('daytona_action_unsupported');
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) return fail('invalid_duration');
    if (checked.type === 'navigate' || checked.type === 'tab_create') {
      let url: URL; try { url = new URL(checked.url); } catch { return fail('destination_forbidden'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return fail('destination_forbidden');
    }
    const result = record(await this.runtime(binding, 'execute', session.sessionId, checked, principalHash, timeoutSeconds));
    if ((result.url !== null && (typeof result.url !== 'string' || result.url.length > 2048)) || (result.title !== null && (typeof result.title !== 'string' || result.title.length > 1024)) || typeof result.visibleText !== 'string' || result.visibleText.length > 20000) return fail('daytona_runtime_invalid');
    if (typeof result.url === 'string') { let url: URL; try { url = new URL(result.url); } catch { return fail('daytona_runtime_invalid'); } if (!['https:', 'http:', 'about:'].includes(url.protocol) || (url.protocol === 'about:' && url.href !== 'about:blank') || url.username || url.password) return fail('destination_forbidden'); }
    let pageReceipt: BrowserPageReceipt | undefined;
    if (result.pageReceipt !== undefined) {
      const value = record(result.pageReceipt); const id = (raw: unknown) => typeof raw === 'string' && raw.length > 0 && raw.length <= 256 && !/[\u0000-\u001f\u007f]/.test(raw);
      if (value.completed !== true || (value.selectedTargetId !== null && !id(value.selectedTargetId)) || (value.createdTargetId !== undefined && !id(value.createdTargetId)) || (value.closedTargetId !== undefined && !id(value.closedTargetId)) || Object.keys(value).some(key => !['completed', 'selectedTargetId', 'createdTargetId', 'closedTargetId'].includes(key))) return fail('daytona_runtime_invalid');
      if (checked.type === 'tab_select' && value.selectedTargetId !== checked.targetId || checked.type === 'tab_close' && value.closedTargetId !== checked.targetId) return fail('daytona_runtime_invalid');
      pageReceipt = { completed: true, selectedTargetId: value.selectedTargetId as string | null, ...(value.createdTargetId ? { createdTargetId: value.createdTargetId as string } : {}), ...(value.closedTargetId ? { closedTargetId: value.closedTargetId as string } : {}) };
    }
    if (['tab_create', 'tab_select', 'tab_close'].includes(checked.type) && !pageReceipt || checked.type === 'tab_create' && !pageReceipt?.createdTargetId) return fail('daytona_runtime_invalid');
    return { observation: { url: result.url as string | null, title: result.title as string | null, visibleText: result.visibleText }, ...(pageReceipt ? { pageReceipt } : {}) };
  }
  async checkpoint(binding: DaytonaBinding): Promise<void> { assertDaytonaBinding(binding); return fail('daytona_checkpoint_unavailable'); }
  async releaseMission(binding: DaytonaBinding, session: DaytonaMission): Promise<void> {
    assertDaytonaBinding(binding); assertDaytonaMission(session);
    if (session.profileKey !== binding.profileKey || session.sandboxId !== binding.sandboxId || session.owner !== binding.owner || session.ownerSubjectHash !== binding.ownerSubjectHash) return fail('owner_forbidden');
    await this.runtime(binding, 'release', session.sessionId);
  }
  private viewer(): DaytonaViewerGrantPort { return this.options.viewer ?? fail('daytona_viewer_unavailable'); }
  private grant(value: ViewerGrant, expectedHandle?: string): ViewerGrant {
    let url: URL; try { url = new URL(value.url); } catch { return fail('daytona_viewer_invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || !UUID.test(value.grantHandle) || (expectedHandle && value.grantHandle !== expectedHandle) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) return fail('daytona_viewer_invalid');
    return { url: value.url, expiresAt: value.expiresAt, grantHandle: value.grantHandle };
  }
  async viewerGrant(binding: DaytonaBinding, expiresSeconds: number): Promise<ViewerGrant> {
    assertDaytonaBinding(binding); if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 300) return fail('invalid_duration');
    return this.bounded(async () => { const grant = this.grant(await this.viewer().mint(binding, expiresSeconds)); if (grant.expiresAt > Date.now() + expiresSeconds * 1000) return fail('daytona_viewer_invalid'); return grant; });
  }
  async readViewerGrant(binding: DaytonaBinding, grantHandle: string): Promise<ViewerGrant> {
    assertDaytonaBinding(binding); if (!UUID.test(grantHandle)) return fail('daytona_viewer_invalid'); return this.bounded(async () => this.grant(await this.viewer().read(binding, grantHandle), grantHandle));
  }
  async revokeViewerGrant(binding: DaytonaBinding, grantHandle: string): Promise<{ human_input_revoked: true }> {
    assertDaytonaBinding(binding); if (!UUID.test(grantHandle)) return fail('daytona_viewer_invalid');
    return this.bounded(async () => { const receipt = await this.viewer().revoke(binding, grantHandle); if (receipt.human_input_revoked !== true) return fail('viewer_revocation_unknown'); return { human_input_revoked: true }; });
  }
}

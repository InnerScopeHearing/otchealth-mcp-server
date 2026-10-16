import type { BrowserCaptureMetadata, CloudBrowserAction, CloudBrowserExecutionResult, CloudBrowserStore } from '../browser-cloud/contract.js';
import type { BrowserPageReceipt } from '../browser-cloud/page-controls.js';
import type { BrowserFileBroker } from '../browser-cloud/file-broker.js';
import type { BrowserFileTransferReceipt } from '../browser-cloud/provider-files.js';
import type { TrustedBrowserBinaryValidator } from '../browser-cloud/binary-validation.js';
import { validateCloudBrowserAction } from '../browser-cloud/actions.js';
import { DaytonaBrowserError, DaytonaViewerNotMintedError, daytonaPhysicalProfileKey, type DaytonaBinding, type DaytonaMission, type DaytonaProvider, type DaytonaRuntimeReadiness } from './contract.js';
export type { DaytonaRuntimeReadiness } from './contract.js';
import { assertDaytonaBinding, assertDaytonaMission } from './store.js';
import { DaytonaTransferBridge, type DaytonaUploadDescriptor, type DaytonaDirectoryReceipt } from './transfer-bridge.js';
import { uploadDaytonaControlledFile, type DaytonaStagePayload } from './toolbox-files.js';

type ViewerGrant = { url: string; expiresAt: number; grantHandle: string };
/** Trusted server-only vault. Revoke must include actual native VNC disconnection proof. */
export interface DaytonaViewerGrantPort {
  mint(binding: DaytonaBinding, expiresSeconds: number, notAfter?: number): Promise<ViewerGrant>;
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
  /** Trusted server-only broker and immutable artifact store; never MCP arguments. */
  files?: Pick<BrowserFileBroker, 'forUpload'>;
  captures?: Pick<CloudBrowserStore, 'createCapture'>;
  /** Trusted structural verifier; production defaults to the bounded binary validator. */
  validator?: TrustedBrowserBinaryValidator;
}
type Context = { signal: AbortSignal; remaining: () => number; token?: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ORDINARY_JSON_BYTES = 131072, ORDINARY_RESULT_CHARS = 100000;
// PNG/PDF bytes stay capped at 4MiB by the artifact decoder. Only fixed typed
// capture commands receive this allowance; all other provider reads stay small.
const CAPTURE_RESULT_CHARS = Math.ceil(4 * 1024 * 1024 / 3) * 4 + 16384;
const CAPTURE_JSON_BYTES = CAPTURE_RESULT_CHARS + 16384;
const fail = (code: string): never => { throw new DaytonaBrowserError(code); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('daytona_provider_invalid');
function httpsUrl(raw: string): URL {
  let url: URL; try { url = new URL(raw); } catch { return fail('daytona_provider_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) return fail('daytona_provider_invalid');
  return url;
}

/** No provisioning methods. Each operation uses the exact approved enrollment and one absolute deadline. */
export class DaytonaApiBrowserProvider implements DaytonaProvider {
  readonly capabilities;
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
    if (options.files !== undefined && typeof options.files?.forUpload !== 'function' || options.captures !== undefined && typeof options.captures?.createCapture !== 'function' || options.validator !== undefined && typeof options.validator?.validate !== 'function') fail('daytona_provider_invalid');
    this.capabilities = Object.freeze({ typedBrowser: true, upload: options.files !== undefined, capture: options.captures !== undefined, captureFormats: Object.freeze(options.captures ? ['png', 'pdf'] : []), checkpoint: false, publicWebNetworkIsolation: false,
      actions: Object.freeze(['navigate', 'snapshot', 'click', 'type', 'focus', 'select', 'wait_for', 'press_key', 'scroll', 'mouse_move', 'drag', 'tab_create', 'tab_select', 'tab_close', 'navigate_back', 'navigate_forward', 'reload', 'dialog', ...(options.files ? ['upload', 'upload_directory'] : []), ...(options.captures ? ['capture'] : [])]), maxActionSeconds: 14 });
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
  private async json(context: Context, url: string, init: RequestInit = {}, maxBytes = ORDINARY_JSON_BYTES): Promise<Record<string, unknown>> {
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
      while (true) { context.remaining(); const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > maxBytes) { await reader.cancel(); return fail('daytona_provider_invalid'); } chunks.push(next.value); }
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
  private assertMission(binding: DaytonaBinding, session: DaytonaMission, principal: string): void {
    assertDaytonaBinding(binding); assertDaytonaMission(session);
    if (session.sandboxId !== binding.sandboxId || session.profileKey !== binding.profileKey || session.owner !== binding.owner || session.ownerSubjectHash !== binding.ownerSubjectHash || principal !== binding.ownerSubjectHash || session.phase !== 'ACTIVE' || session.sensitiveOutputSuppressed || session.expiresAt <= Date.now()) fail('owner_forbidden');
  }
  private async toolboxWith(context: Context, binding: DaytonaBinding): Promise<URL> {
    const state = await this.inspectWith(context, binding); if (state.state !== 'started' || state.public !== false) return fail('daytona_not_ready');
    const proxy = await this.json(context, `${this.base.href}/sandbox/${encodeURIComponent(binding.sandboxId)}/toolbox-proxy-url`);
    if (typeof proxy.url !== 'string') return fail('daytona_provider_invalid'); const base = httpsUrl(proxy.url);
    if (!this.origins.has(base.origin)) return fail('daytona_toolbox_origin_forbidden');
    return base;
  }
  private async processWith(context: Context, base: URL, binding: DaytonaBinding, command: string, timeoutMs: number, binaryCapture = false): Promise<Record<string, unknown>> {
    context.remaining();
    const response = await this.json(context, `${base.href.replace(/\/+$/, '')}/${encodeURIComponent(binding.sandboxId)}/process/execute`, { method: 'POST', body: JSON.stringify({ command, timeout: Math.ceil(timeoutMs / 1000) }) }, binaryCapture ? CAPTURE_JSON_BYTES : ORDINARY_JSON_BYTES);
    if ((response.exitCode ?? response.code) !== 0 || typeof response.result !== 'string' || response.result.length > (binaryCapture ? CAPTURE_RESULT_CHARS : ORDINARY_RESULT_CHARS)) return fail('daytona_runtime_unavailable');
    let parsed: unknown; try { parsed = JSON.parse(response.result); } catch { return fail('daytona_runtime_invalid'); }
    return record(parsed);
  }
  private async runtimeWith(context: Context, binding: DaytonaBinding, op: 'probe' | 'open' | 'execute' | 'release' | 'checkpoint' | 'human_pause' | 'human_resume', sessionId?: string, action?: CloudBrowserAction, principalHash?: string, timeoutSeconds = 18, upload?: DaytonaUploadDescriptor, runtimeProtocol?: 2): Promise<unknown> {
    assertDaytonaBinding(binding); if (sessionId !== undefined && !UUID.test(sessionId)) return fail('owner_forbidden');
    const base = await this.toolboxWith(context, binding);
    // Official execute timeout is seconds; retain five seconds for its terminal receipt.
    const timeoutMs = Math.min(14000, timeoutSeconds * 1000, context.remaining() - 5000); if (timeoutMs < 1000) return fail('daytona_provider_timeout');
    const physicalKey = daytonaPhysicalProfileKey(binding);
    const payload = { version: 1, op, profileKey: physicalKey, profilePath: binding.profilePath, timeoutMs: Math.floor(timeoutMs), ...(sessionId ? { sessionId } : {}), ...(action ? { action } : {}), principalHash: principalHash ?? binding.ownerSubjectHash, ...(upload ? { upload } : {}), ...(runtimeProtocol === 2 ? { runtimeProtocol: 2 } : {}) };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    if (encoded.length > 32768) return fail('daytona_runtime_invalid');
    const command = `sudo -n runuser -u otcbrowser -- python3 -I /opt/otchealth-browser/browser-dispatcher.py --payload ${encoded}`;
    const binaryCapture = op === 'execute' && action?.type === 'capture' && (action.request.type === 'pdf' || action.request.type === 'screenshot' && (!action.request.format || action.request.format === 'png'));
    const receipt = await this.processWith(context, base, binding, command, timeoutMs, binaryCapture);
    // Only the V2 dispatcher promises these exact negative ACKs were emitted
    // before any effect. Nonzero exits and all other receipts stay unknown.
    if (runtimeProtocol === 2 && upload?.phase !== 'attach' && receipt.version === 1 && receipt.ok === false && receipt.beforeEffect === true && typeof receipt.code === 'string'
      && ['mission_busy', 'human_active', 'other_missions_active'].includes(receipt.code)
      && Object.keys(receipt).length === 4 && Object.keys(receipt).every(key => ['version', 'ok', 'code', 'beforeEffect'].includes(key))) return fail('daytona_operation_busy');
    if (receipt.version !== 1 || receipt.ok !== true || receipt.profileKey !== physicalKey || receipt.profilePath !== binding.profilePath || (sessionId !== undefined && receipt.sessionId !== sessionId)) return fail('daytona_runtime_invalid');
    const result = record(receipt.result);
    if ((op === 'probe' || op === 'open') && (result.ready !== true || result.cdpLoopback !== true || result.profileVerified !== true)) return fail('daytona_runtime_unavailable');
    if (op === 'release' && result.released !== true) return fail('daytona_runtime_invalid');
    return result;
  }
  private async runtime(binding: DaytonaBinding, op: 'probe' | 'open' | 'execute' | 'release' | 'checkpoint' | 'human_pause' | 'human_resume', sessionId?: string, action?: CloudBrowserAction, principalHash?: string, timeoutSeconds = 18, runtimeProtocol?: 2): Promise<unknown> {
    assertDaytonaBinding(binding);
    return this.bounded(context => this.runtimeWith(context, binding, op, sessionId, action, principalHash, timeoutSeconds, undefined, runtimeProtocol));
  }
  private async transfer(binding: DaytonaBinding, session: DaytonaMission, action: Extract<CloudBrowserAction, { type: 'upload' | 'upload_directory' | 'capture' }>, seconds: number, principal: string): Promise<BrowserCaptureMetadata | BrowserFileTransferReceipt | DaytonaDirectoryReceipt> {
    if (action.type !== 'capture' && !this.options.files || action.type === 'capture' && (!this.options.captures || action.request.type !== 'pdf' && (action.request.type !== 'screenshot' || action.request.format && action.request.format !== 'png'))) return fail('daytona_action_unsupported');
    return this.bounded(async outer => {
      const guarded = (remaining: () => number): Context => ({ signal: outer.signal, get token() { return outer.token; }, set token(value) { outer.token = value; }, remaining: () => { this.assertMission(binding, session, principal); return Math.min(outer.remaining(), remaining()); } });
      const current = () => { outer.remaining(); this.assertMission(binding, session, principal); };
      const bridge = new DaytonaTransferBridge({
        files: this.options.files ? { forUpload: async (owner, fileId, subject) => { current(); if (owner !== binding.owner || subject !== principal) return fail('owner_forbidden'); const file = await this.options.files!.forUpload(owner, fileId, subject); current(); return file; } } : undefined,
        captures: this.options.captures ? { createCapture: async (owner, sessionId, artifact, createdAt, subject) => { current(); if (owner !== binding.owner || sessionId !== session.sessionId || subject !== principal) return fail('owner_forbidden'); const metadata = await this.options.captures!.createCapture(owner, sessionId, artifact, createdAt, subject); current(); return metadata; } } : undefined,
        validator: this.options.validator, remote: {
        run: async (target, mission, typedAction, descriptor, remaining, subject) => {
          this.assertMission(target, mission, subject); const context = guarded(remaining);
          const result = await this.runtimeWith(context, target, 'execute', mission.sessionId, typedAction, subject, seconds, descriptor, mission.runtimeProtocol);
          context.remaining(); return result;
        },
        upload: async (target, mission, path, body, remaining, subject) => {
          this.assertMission(target, mission, subject); const context = guarded(remaining);
          const base = await this.toolboxWith(context, target); context.remaining();
          await uploadDaytonaControlledFile({ binding: target, session: mission, path, body, toolboxBaseUrl: base.href, allowedOrigins: [...this.origins], token: context.token!, remaining: context.remaining,
            fetchImpl: async (input, init) => { context.remaining(); const response = await this.fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([context.signal, init.signal]) : context.signal }); context.remaining(); return response; },
            promote: (payload, stageRemaining) => this.promoteWith(guarded(stageRemaining), base, target, mission, payload, subject) });
          context.remaining();
        },
      } });
      const result = action.type === 'upload_directory'
        ? await bridge.uploadDirectory(binding, session, action.selector, action.files, seconds, principal)
        : await bridge.execute(binding, session, action, seconds, principal);
      outer.remaining(); this.assertMission(binding, session, principal); return result;
    });
  }
  private async promoteWith(context: Context, base: URL, binding: DaytonaBinding, session: DaytonaMission, payload: DaytonaStagePayload, principal: string): Promise<{ staged: true; sha256: string; byteLength: number }> {
    this.assertMission(binding, session, principal); context.remaining();
    if (payload.profileKey !== binding.profileKey || payload.sessionId !== session.sessionId || payload.principalHash !== principal || payload.runtimeProtocol !== session.runtimeProtocol) return fail('owner_forbidden');
    const timeoutMs = Math.min(14000, context.remaining() - 5000); if (timeoutMs < 1000) return fail('daytona_provider_timeout');
    // The broker/session above retain virtual principal ownership. Only this
    // fixed root-helper wire identity changes to the enrolled physical profile.
    const physicalKey = daytonaPhysicalProfileKey(binding);
    const encoded = Buffer.from(JSON.stringify({ ...payload, profileKey: physicalKey })).toString('base64url'); if (encoded.length > 4096) return fail('daytona_upload_invalid');
    const receipt = await this.processWith(context, base, binding, `sudo -n python3 -I /opt/otchealth-browser/transfer-stage.py --payload ${encoded}`, timeoutMs);
    context.remaining();
    if (receipt.version !== 1 || receipt.ok !== true || receipt.staged !== true || receipt.profileKey !== physicalKey || receipt.sessionId !== session.sessionId || receipt.runtimeProtocol !== session.runtimeProtocol || receipt.sha256 !== payload.sha256 || receipt.byteLength !== payload.byteLength) return fail('daytona_upload_unconfirmed');
    return { staged: true, sha256: payload.sha256, byteLength: payload.byteLength };
  }
  /** Read-only local runtime readiness, never browser/resource launch. */
  async probe(binding: DaytonaBinding): Promise<DaytonaRuntimeReadiness> {
    const result = record(await this.runtime(binding, 'probe'));
    const pid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    let multiMission: Pick<DaytonaRuntimeReadiness, 'runtimeProtocol' | 'multiMissionReady'> = {};
    if (result.runtimeProtocol !== undefined || result.multiMissionReady !== undefined) {
      if (result.runtimeProtocol !== 2 || typeof result.multiMissionReady !== 'boolean' || result.profileKey !== daytonaPhysicalProfileKey(binding) || result.profilePath !== binding.profilePath) return fail('daytona_runtime_invalid');
      multiMission = { runtimeProtocol: 2, multiMissionReady: result.multiMissionReady };
    }
    if (result.checkpointReady === true) {
      if (result.profileKey !== daytonaPhysicalProfileKey(binding) || result.profilePath !== binding.profilePath || result.encryptedKeyringUnlocked !== true || !pid(result.browserPid) || !pid(result.supervisorPid)) return fail('daytona_runtime_invalid');
      return { ready: true, profileKey: binding.profileKey, profilePath: binding.profilePath, checkpointReady: true, browserPid: result.browserPid, supervisorPid: result.supervisorPid, ...multiMission };
    }
    return { ready: true, profileKey: binding.profileKey, profilePath: binding.profilePath, checkpointReady: false, ...multiMission };
  }
  async openMission(binding: DaytonaBinding, logicalSessionId: string, options: { runtimeProtocol?: 2 } = {}): Promise<void> {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'runtimeProtocol') || 'runtimeProtocol' in options && options.runtimeProtocol !== 2) return fail('owner_forbidden');
    await this.runtime(binding, 'open', logicalSessionId, undefined, undefined, 18, options.runtimeProtocol);
  }
  async execute(binding: DaytonaBinding, session: DaytonaMission, action: CloudBrowserAction, timeoutSeconds: number, principalHash: string): Promise<CloudBrowserExecutionResult | BrowserCaptureMetadata | BrowserFileTransferReceipt | DaytonaDirectoryReceipt> {
    this.assertMission(binding, session, principalHash);
    const checked = validateCloudBrowserAction(action);
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) return fail('invalid_duration');
    if (checked.type === 'upload' || checked.type === 'upload_directory' || checked.type === 'capture') return this.transfer(binding, session, checked, timeoutSeconds, principalHash);
    if (checked.type === 'navigate' || checked.type === 'tab_create') {
      let url: URL; try { url = new URL(checked.url); } catch { return fail('destination_forbidden'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return fail('destination_forbidden');
    }
    const result = record(await this.runtime(binding, 'execute', session.sessionId, checked, principalHash, timeoutSeconds, session.runtimeProtocol));
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
  async checkpoint(binding: DaytonaBinding, session?: DaytonaMission): Promise<void> {
    assertDaytonaBinding(binding); if (!session) return fail('owner_forbidden'); assertDaytonaMission(session);
    if (session.owner !== binding.owner || session.ownerSubjectHash !== binding.ownerSubjectHash || session.profileKey !== binding.profileKey || session.sandboxId !== binding.sandboxId || session.phase !== 'ACTIVE' || session.expiresAt <= Date.now()) return fail('owner_forbidden');
    const result = record(await this.runtime(binding, 'checkpoint', session.sessionId, undefined, binding.ownerSubjectHash, 18, session.runtimeProtocol));
    const pid = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    if (result.checkpointed !== true || result.gracefulClosed !== true || result.keyringSessionRetained !== true || result.cdpLoopback !== true || result.profileVerified !== true || result.tabsReset !== true || result.profileKey !== daytonaPhysicalProfileKey(binding) || result.profilePath !== binding.profilePath || result.sessionId !== session.sessionId || result.principalHash !== binding.ownerSubjectHash || !pid(result.browserPidBefore) || !pid(result.browserPidAfter) || result.browserPidBefore === result.browserPidAfter || !pid(result.supervisorPid)) return fail('daytona_checkpoint_unverified');
  }
  async releaseMission(binding: DaytonaBinding, session: DaytonaMission): Promise<void> {
    assertDaytonaBinding(binding); assertDaytonaMission(session);
    if (session.profileKey !== binding.profileKey || session.sandboxId !== binding.sandboxId || session.owner !== binding.owner || session.ownerSubjectHash !== binding.ownerSubjectHash) return fail('owner_forbidden');
    await this.runtime(binding, 'release', session.sessionId, undefined, undefined, 18, session.runtimeProtocol);
  }
  private assertHumanMission(binding: DaytonaBinding, session: DaytonaMission): void {
    assertDaytonaBinding(binding); assertDaytonaMission(session);
    // Handoff persists suppression/unknown before pause and retains it until
    // revoke+checkpoint+resume succeed. Those flags must not bypass cleanup.
    if (session.runtimeProtocol !== 2 || session.owner !== binding.owner || session.ownerSubjectHash !== binding.ownerSubjectHash || session.profileKey !== binding.profileKey || session.sandboxId !== binding.sandboxId || session.phase !== 'ACTIVE' || session.expiresAt <= Date.now()) return fail('owner_forbidden');
  }
  async pauseAutomation(binding: DaytonaBinding, session: DaytonaMission): Promise<{ paused: true }> {
    this.assertHumanMission(binding, session);
    const result = record(await this.runtime(binding, 'human_pause', session.sessionId, undefined, binding.ownerSubjectHash, 18, 2));
    if (result.paused !== true) return fail('daytona_human_pause_unverified');
    return { paused: true };
  }
  async resumeAutomation(binding: DaytonaBinding, session: DaytonaMission): Promise<{ resumed: true }> {
    this.assertHumanMission(binding, session);
    const result = record(await this.runtime(binding, 'human_resume', session.sessionId, undefined, binding.ownerSubjectHash, 18, 2));
    if (result.resumed !== true) return fail('daytona_human_resume_unverified');
    return { resumed: true };
  }
  private viewer(): DaytonaViewerGrantPort { return this.options.viewer ?? fail('daytona_viewer_unavailable'); }
  private grant(value: ViewerGrant, expectedHandle?: string): ViewerGrant {
    let url: URL; try { url = new URL(value.url); } catch { return fail('daytona_viewer_invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || !UUID.test(value.grantHandle) || (expectedHandle && value.grantHandle !== expectedHandle) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) return fail('daytona_viewer_invalid');
    return { url: value.url, expiresAt: value.expiresAt, grantHandle: value.grantHandle };
  }
  async viewerGrant(binding: DaytonaBinding, expiresSeconds: number, notAfter?: number): Promise<ViewerGrant> {
    assertDaytonaBinding(binding); if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 300) return fail('invalid_duration');
    if (notAfter !== undefined && !Number.isSafeInteger(notAfter)) return fail('invalid_duration');
    // This is the only trusted no-mint negative: no viewer port has been called.
    if (notAfter !== undefined && notAfter <= Date.now()) throw new DaytonaViewerNotMintedError();
    // With a mission deadline the service must first retain the known owned
    // handle before rejecting a late/invalid receipt. Do not lose it here.
    return this.bounded(async () => {
      let value: ViewerGrant;
      try { value = await this.viewer().mint(binding, expiresSeconds, notAfter); }
      catch (error) { if (error instanceof DaytonaViewerNotMintedError) return fail('daytona_viewer_unavailable'); throw error; }
      if (notAfter !== undefined) return value;
      const grant = this.grant(value); if (grant.expiresAt > Date.now() + expiresSeconds * 1000) return fail('daytona_viewer_invalid'); return grant;
    });
  }
  async readViewerGrant(binding: DaytonaBinding, grantHandle: string): Promise<ViewerGrant> {
    assertDaytonaBinding(binding); if (!UUID.test(grantHandle)) return fail('daytona_viewer_invalid'); return this.bounded(async () => this.grant(await this.viewer().read(binding, grantHandle), grantHandle));
  }
  async revokeViewerGrant(binding: DaytonaBinding, grantHandle: string): Promise<{ human_input_revoked: true }> {
    assertDaytonaBinding(binding); if (!UUID.test(grantHandle)) return fail('daytona_viewer_invalid');
    return this.bounded(async () => { const receipt = await this.viewer().revoke(binding, grantHandle); if (receipt.human_input_revoked !== true) return fail('viewer_revocation_unknown'); return { human_input_revoked: true }; });
  }
}

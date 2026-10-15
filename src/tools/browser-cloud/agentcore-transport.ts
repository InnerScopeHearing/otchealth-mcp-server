import { randomUUID } from "node:crypto";
import { WebSocket } from "undici";
import { signRequest, resolveAwsCredentials, type AwsCredentials } from "../../search/sigv4.js";
import { signAgentCoreAutomationStream } from "../browser-agentcore/transport.js";
import type { CloudBrowserAction, CloudBrowserObservation, CloudBrowserProfile, CloudBrowserSession, CloudBrowserTransport } from "./contract.js";
import { CloudBrowserError } from "./contract.js";
import { executeCloudBrowserInteraction } from "./actions.js";
import { BrowserPageController } from "./page-controls.js";
import { captureBrowserArtifact, type BrowserCaptureValidator } from './captures.js';
import { createTrustedBrowserBinaryValidator } from './binary-validation.js';
import { assertTrustedPublicWebProfile, type TrustedPublicWebPolicy } from './public-web-policy.js';
import { attachStagedFileToOwnedInput, type BrowserFileResolver } from './provider-files.js';
import { websiteLoginPolicy, type WebsiteLoginSite } from './website-login-service.js';
import { CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS } from './service.js';
import type { WebsiteLoginTarget } from './website-login-policy.js';

const BROWSER_ID = "aws.browser.v1";
type FrameMessage = { id?: unknown; result?: unknown; error?: unknown };

export function isAllowedBrowserUrl(raw: unknown, allowedHosts: readonly string[], allowHttp = false): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || (allowHttp && url.protocol === "http:")) && !url.username && !url.password && (allowHttp || (!url.port && allowedHosts.includes(url.hostname.toLowerCase())));
  } catch {
    return false;
  }
}

/** Minimal bounded CDP client. It offers no Runtime.evaluate or arbitrary command entrypoint. */
type Ws = Pick<WebSocket, "send" | "close" | "addEventListener">;
type WsFactory = (url: string, options: { headers: Record<string, string> }) => Ws;
const MAX_MESSAGE_BYTES = 5_600_000; // 4 MiB artifact as base64 plus bounded CDP envelope.
const MAX_QUEUED_MESSAGE_BYTES = MAX_MESSAGE_BYTES + 128 * 1024;
const MAX_QUEUED_FRAMES = 32;
const trustedBinaryValidator = createTrustedBrowserBinaryValidator();
const defaultCaptureValidator: BrowserCaptureValidator = input => trustedBinaryValidator.validate(input);
class Cdp {
  private readonly frames: string[] = [];
  private queuedBytes = 0;
  private wake?: () => void;
  private closed = false;
  private id = 1;
  private constructor(private readonly socket: Ws) {
    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      const bytes = Buffer.byteLength(text);
      if (bytes > MAX_MESSAGE_BYTES || this.frames.length >= MAX_QUEUED_FRAMES || this.queuedBytes + bytes > MAX_QUEUED_MESSAGE_BYTES) {
        this.closed = true;
        socket.close();
      } else {
        this.frames.push(text);
        this.queuedBytes += bytes;
        this.notify();
      }
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      this.notify();
    });
    socket.addEventListener("error", () => {
      this.closed = true;
      this.notify();
    });
  }
  static async open(endpoint: string, headers: Record<string, string>, timeout: number, factory: WsFactory = (url, options) => new WebSocket(url, options)): Promise<Cdp> {
    if (new URL(endpoint).protocol !== "wss:") throw new CloudBrowserError("provider_stream_invalid", "AgentCore returned a non-secure browser stream.");
    const socket = factory(endpoint, { headers });
    const cdp = new Cdp(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new CloudBrowserError("provider_timeout", "Browser stream connection timed out."));
      }, timeout);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new CloudBrowserError("provider_stream_failed", "Browser stream connection failed."));
        },
        { once: true },
      );
    });
    return cdp;
  }
  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
  async command(method: string, params: Record<string, unknown>, timeout: number, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.id++;
    const text = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    });
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new CloudBrowserError("provider_stream_invalid", "Browser command exceeded the bound.");
    this.socket.send(text);
    const until = Date.now() + timeout;
    for (;;) {
      while (this.frames.length) {
          const frame = this.frames.shift() as string;
          this.queuedBytes -= Buffer.byteLength(frame);
          let msg: FrameMessage;
        try {
            msg = JSON.parse(frame) as FrameMessage;
        } catch {
          continue;
        }
        if (msg.id !== id) continue;
        if (msg.error) throw new CloudBrowserError("provider_action_failed", "AgentCore rejected the browser action.");
        return (msg.result ?? {}) as Record<string, unknown>;
      }
      const remain = until - Date.now();
      if (remain <= 0 || this.closed) throw new CloudBrowserError("provider_timeout", "Browser action timed out.");
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, remain);
        this.wake = done;
      });
    }
  }
  close(): void {
    this.socket.close();
    this.closed = true;
  }
}

export class AgentCoreCloudBrowserTransport implements CloudBrowserTransport {
  async prepareWebsiteLogin(session: CloudBrowserSession, site: WebsiteLoginSite, target?: WebsiteLoginTarget): Promise<void> {
    await this.websiteLoginPage(session, site, true, target);
    // AgentCore keeps live-view input read-only while automation owns the stream.
    // Navigate and close CDP before handing the suppressed session to its human owner.
    await this.websiteAutomationStream(session, site, 'DISABLED', target);
  }
  async verifyWebsiteLogin(session: CloudBrowserSession, site: WebsiteLoginSite, target?: WebsiteLoginTarget): Promise<void> {
    // Only the trusted Done path calls this method. Output remains suppressed.
    await this.websiteAutomationStream(session, site, 'ENABLED', target);
    await this.websiteLoginPage(session, site, false, target);
  }
  private checkedWebsiteLoginPolicy(session: CloudBrowserSession, site: WebsiteLoginSite, target?: WebsiteLoginTarget): ReturnType<typeof websiteLoginPolicy> {
    const policy = websiteLoginPolicy(site, target);
    if (!(CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS as readonly string[]).includes(session.owner) || !/^[a-f0-9]{64}$/.test(session.ownerSubjectHash ?? '') || !session.sensitiveOutputSuppressed || session.providerBrowserId !== BROWSER_ID || session.mode === 'public_web' || session.allowedHosts.length !== policy.allowedHosts.length || session.allowedHosts.some((host, index) => host !== policy.allowedHosts[index])) throw new CloudBrowserError('login_invalid', 'The owned sign-in session is invalid.');
    return policy;
  }
  private async websiteAutomationStream(session: CloudBrowserSession, site: WebsiteLoginSite, streamStatus: 'DISABLED' | 'ENABLED', target?: WebsiteLoginTarget): Promise<void> {
    this.checkedWebsiteLoginPolicy(session, site, target);
    if (!/^[0-9a-zA-Z]{1,40}$/.test(session.providerSessionId)) throw new CloudBrowserError('login_invalid', 'The owned sign-in session is invalid.');
    const credentials = await resolveAwsCredentials();
    if (!credentials) throw new CloudBrowserError('aws_credentials_unavailable', 'Browser runtime credentials are unavailable.');
    const host = `bedrock-agentcore.${this.region}.amazonaws.com`;
    const path = `/browsers/${encodeURIComponent(BROWSER_ID)}/sessions/streams/update`;
    const query = { sessionId: session.providerSessionId };
    const body = JSON.stringify({ clientToken: randomUUID(), streamUpdate: { automationStreamUpdate: { streamStatus } } });
    const signed = signRequest({ method: 'PUT', host, path, query, body, region: this.region, service: 'bedrock-agentcore', credentials, extraHeaders: { 'content-type': 'application/json' } });
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${host}${path}?sessionId=${encodeURIComponent(session.providerSessionId)}`, { method: 'PUT', headers: signed.headers, body, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new CloudBrowserError('provider_stream_update_failed', 'The browser control handoff could not be confirmed.');
    }
    if (!response.ok) throw new CloudBrowserError(`provider_stream_update_${response.status}`, `AgentCore request failed with HTTP ${response.status}.`);
    const receipt = await response.json().catch(() => null) as { browserIdentifier?: unknown; sessionId?: unknown; streams?: { automationStream?: { streamStatus?: unknown } } } | null;
    if (receipt?.browserIdentifier !== BROWSER_ID || receipt.sessionId !== session.providerSessionId || receipt.streams?.automationStream?.streamStatus !== streamStatus) throw new CloudBrowserError('provider_stream_receipt_invalid', 'The provider did not confirm the exact owned browser control handoff.');
  }
  /** Fixed trusted login path. No DOM text, credentials or form values leave this method. */
  private async websiteLoginPage(session: CloudBrowserSession, site: WebsiteLoginSite, navigate: boolean, target?: WebsiteLoginTarget): Promise<void> {
    const policy = this.checkedWebsiteLoginPolicy(session, site, target);
    const credentials = await resolveAwsCredentials();
    if (!credentials) throw new CloudBrowserError('aws_credentials_unavailable', 'Browser runtime credentials are unavailable.');
    const cdp = await Cdp.open(session.automationEndpoint, signAgentCoreAutomationStream({ ...credentials, sessionToken: credentials.sessionToken ?? '', region: this.region }, session.automationEndpoint), 10_000, this.webSocketFactory);
    try {
      const targets = await cdp.command('Target.getTargets', {}, 5000);
      const pages = (targets.targetInfos as Array<{ type?: string; targetId?: string; url?: string }> | undefined)?.filter(t => t.type === 'page' && typeof t.targetId === 'string') ?? [];
      const target = navigate ? pages[0] : pages.find(t => t.targetId === session.selectedTargetId && session.ownedTargetIds?.includes(t.targetId!));
      if (!target?.targetId) throw new CloudBrowserError('login_page_missing', 'The sign-in window is unavailable.');
      const attached = await cdp.command('Target.attachToTarget', { targetId: target.targetId, flatten: true }, 5000);
      if (typeof attached.sessionId !== 'string') throw new CloudBrowserError('login_page_missing', 'The sign-in window is unavailable.');
      const page = attached.sessionId;
      if (navigate) {
        const result = await cdp.command('Page.navigate', { url: policy.loginUrl }, 10_000, page);
        if (result.errorText) throw new CloudBrowserError('login_navigation_failed', 'The company sign-in page could not be opened.');
        session.ownedTargetIds = [target.targetId]; session.selectedTargetId = target.targetId;
        return;
      }
      let url: URL;
      try { url = new URL(target.url ?? 'about:blank'); } catch { throw new CloudBrowserError('company_sign_in_required', 'Open the requested company website before clicking Done.'); }
      if (url.protocol !== 'https:' || url.hostname !== policy.host || url.username || url.password || url.port || !policy.signedInPath.test(url.pathname)) throw new CloudBrowserError('company_sign_in_required', 'Open the requested company website before clicking Done.');
      const dom = await cdp.command('DOM.getDocument', { depth: 0 }, 5000, page);
      const root = dom.root as { nodeId?: number } | undefined;
      if (!root?.nodeId) throw new CloudBrowserError('company_sign_in_required', 'The company website is not ready.');
      const password = await cdp.command('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="password"]' }, 5000, page);
      if (password.nodeId !== 0) throw new CloudBrowserError('company_sign_in_required', 'Complete the company sign-in first.');
    } finally { cdp.close(); }
  }
  /** Server-owned authentication path: no DOM or form values are returned to the model. */
  async prepareIntercomLogin(session: CloudBrowserSession, workspace: string, host = 'app.intercom.com'): Promise<void> {
    if (!/^[A-Za-z0-9]{3,32}$/.test(workspace) || session.owner !== 'coo' || !session.ownerSubjectHash || !session.sensitiveOutputSuppressed) throw new CloudBrowserError('login_invalid', 'The owned sign-in session is invalid.');
    await this.intercomLoginPage(session, workspace, true, host);
  }
  async verifyIntercomLogin(session: CloudBrowserSession, workspace: string, host = 'app.intercom.com'): Promise<void> {
    if (!/^[A-Za-z0-9]{3,32}$/.test(workspace) || session.owner !== 'coo' || !session.ownerSubjectHash || !session.sensitiveOutputSuppressed) throw new CloudBrowserError('login_invalid', 'The owned sign-in session is invalid.');
    await this.intercomLoginPage(session, workspace, false, host);
  }
  private async intercomLoginPage(session: CloudBrowserSession, workspace: string, navigate: boolean, host: string): Promise<void> {
    if (!['app.intercom.com','app.eu.intercom.com','app.au.intercom.com'].includes(host)) throw new CloudBrowserError('invalid_workspace','Company workspace host is invalid.');
    const credentials = await resolveAwsCredentials();
    if (!credentials) throw new CloudBrowserError('aws_credentials_unavailable', 'Browser runtime credentials are unavailable.');
    const cdp = await Cdp.open(session.automationEndpoint, signAgentCoreAutomationStream({ ...credentials, sessionToken: credentials.sessionToken ?? '', region: this.region }, session.automationEndpoint), 10_000, this.webSocketFactory);
    try {
      const targets = await cdp.command('Target.getTargets', {}, 5000);
      const pages = (targets.targetInfos as Array<{ type?: string; targetId?: string; url?: string }> | undefined)?.filter(t => t.type === 'page' && typeof t.targetId === 'string') ?? [];
      const target = navigate ? pages[0] : pages.find(t => session.ownedTargetIds?.includes(t.targetId!));
      if (!target?.targetId) throw new CloudBrowserError('login_page_missing', 'The sign-in window is unavailable.');
      const attached = await cdp.command('Target.attachToTarget', { targetId: target.targetId, flatten: true }, 5000);
      const page = attached.sessionId;
      if (typeof page !== 'string') throw new CloudBrowserError('login_page_missing', 'The sign-in window is unavailable.');
      if (navigate) {
        const result = await cdp.command('Page.navigate', { url: `https://${host}/a/apps/${workspace}/settings/workspace/general` }, 10_000, page);
        if (result.errorText) throw new CloudBrowserError('login_navigation_failed', 'The company sign-in page could not be opened.');
        session.ownedTargetIds = [target.targetId]; session.selectedTargetId = target.targetId;
        return;
      }
      const url = new URL(target.url || 'about:blank');
      if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port || !new RegExp(`^/a/apps/${workspace}/settings(?:/|$)`).test(url.pathname)) throw new CloudBrowserError('company_sign_in_required', 'Open the requested company workspace Settings before clicking Done.');
      const dom = await cdp.command('DOM.getDocument', { depth: 0 }, 5000, page);
      const root = dom.root as { nodeId?: number } | undefined;
      if (!root?.nodeId) throw new CloudBrowserError('company_sign_in_required', 'The company settings page is not ready.');
      const password = await cdp.command('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="password"]' }, 5000, page);
      if (password.nodeId !== 0) throw new CloudBrowserError('company_sign_in_required', 'Complete the company sign-in first.');
      // No cookie values, form text, page content, or request bodies leave this runtime.
    } finally { cdp.close(); }
  }
  constructor(
    private readonly region = process.env.AWS_REGION || "us-east-1",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly webSocketFactory: WsFactory = (url, options) => new WebSocket(url, options),
    private readonly captureValidator: BrowserCaptureValidator = defaultCaptureValidator,
    private readonly trustedPublicWebPolicy?: TrustedPublicWebPolicy,
    /** Server-only owner-scoped port; never sourced from an MCP caller. */
    private readonly uploadFileResolver?: BrowserFileResolver,
  ) {}
  private async request(method: string, path: string, body: unknown, credentials: AwsCredentials): Promise<unknown> {
    const host = `bedrock-agentcore.${this.region}.amazonaws.com`;
    const text = body === undefined ? "" : JSON.stringify(body);
    const signed = signRequest({
      method,
      host,
      path,
      body: text,
      region: this.region,
      service: "bedrock-agentcore",
      credentials,
      extraHeaders: { "content-type": "application/json" },
    });
    const response = await this.fetchImpl(`https://${host}${path}`, {
      method,
      headers: signed.headers,
      body: text || undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      const type = /(?:__type|code|Code)"?\s*[:=]\s*"?([A-Za-z]+(?:Exception|Error))/.exec(raw)?.[1];
      throw new CloudBrowserError(`provider_request_${response.status}${type ? `_${type}` : ""}`, `AgentCore request failed with HTTP ${response.status}${type ? ` (${type})` : ""}.`);
    }
    return response.json();
  }
  async start(input: { owner: string; profile: CloudBrowserProfile; maxSeconds: number }): Promise<Pick<CloudBrowserSession, "providerSessionId" | "automationEndpoint" | "providerBrowserId">> {
    const profile = input.profile;
    const publicWeb = profile.mode === "public_web";
    if (publicWeb) assertTrustedPublicWebProfile(profile, this.trustedPublicWebPolicy, this.region);
    const browserId = publicWeb ? profile.customBrowserIdentifier! : BROWSER_ID;
    const credentials = await resolveAwsCredentials();
    if (!credentials) throw new CloudBrowserError("aws_credentials_unavailable", "Cloud browser runtime credentials are unavailable.");
    const value = (await this.request(
      "PUT",
      `/browsers/${encodeURIComponent(browserId)}/sessions/start`,
      {
        name: `cloud-${profile.profileId}`,
        sessionTimeoutSeconds: input.maxSeconds,
        clientToken: randomUUID(),
        ...(publicWeb ? { proxyConfiguration: profile.proxyConfiguration } : {}),
        ...(profile.persistent && profile.providerProfileId
          ? {
              profileConfiguration: {
                profileIdentifier: profile.providerProfileId,
              },
            }
          : {}),
      },
      credentials,
    )) as {
      sessionId?: unknown;
      streams?: { automationStream?: { streamEndpoint?: unknown } };
    };
    if (typeof value.sessionId !== "string" || typeof value.streams?.automationStream?.streamEndpoint !== "string") throw new CloudBrowserError("provider_session_invalid", "AgentCore did not return a usable browser session.");
    return {
      providerSessionId: value.sessionId,
      automationEndpoint: value.streams.automationStream.streamEndpoint,
      providerBrowserId: browserId,
    };
  }
  async execute(session: CloudBrowserSession, action: CloudBrowserAction, timeoutSeconds: number): Promise<CloudBrowserObservation | null | import("./contract.js").CloudBrowserExecutionResult> {
    const credentials = await resolveAwsCredentials();
    if (!credentials) throw new CloudBrowserError("aws_credentials_unavailable", "Cloud browser runtime credentials are unavailable.");
    const signingCredentials = {
      ...credentials,
      sessionToken: credentials.sessionToken ?? "",
      region: this.region,
    };
    const deadline = Date.now() + timeoutSeconds * 1_000;
    const remaining = (): number => {
      const value = deadline - Date.now();
      if (value <= 0) throw new CloudBrowserError("provider_timeout", "Browser action exceeded its total deadline.");
      return value;
    };
    const cdp = await Cdp.open(session.automationEndpoint, signAgentCoreAutomationStream(signingCredentials, session.automationEndpoint), Math.min(remaining(), 10_000), this.webSocketFactory);
    try {
      const targets = await cdp.command("Target.getTargets", {}, remaining());
      const pages = (targets.targetInfos as Array<{ type?: string; targetId?: string }> | undefined)?.filter((x) => x.type === "page" && typeof x.targetId === "string") ?? [];
      if (!session.ownedTargetIds) session.ownedTargetIds = pages[0]?.targetId ? [pages[0].targetId] : [];
      if (!session.selectedTargetId && session.selectedTargetId !== null) session.selectedTargetId = session.ownedTargetIds[0] ?? null;
      const allowUrl = (url: string): boolean => isAllowedBrowserUrl(url, session.allowedHosts, session.mode === "public_web");
      const context = {
        ownedTargetIds: new Set(session.ownedTargetIds),
        selectedTargetId: session.selectedTargetId ?? null,
        allowUrl,
        dialogAcceptanceAuthorized: false,
      };
      const controller = new BrowserPageController(cdp, context);
      const selected = (): string => {
        const id = context.selectedTargetId;
        if (!id || !context.ownedTargetIds.has(id)) throw new CloudBrowserError("target_not_selected", "No owned browser tab is selected.");
        return id;
      };
      const attach = async (id: string): Promise<string> => {
        const info = pages.find((x) => x.targetId === id);
        if (!context.ownedTargetIds.has(id) || (!info && !session.ownedTargetIds?.includes(id))) throw new CloudBrowserError("target_not_owned", "The browser tab is not owned by this session.");
        const result = await cdp.command("Target.attachToTarget", { targetId: id, flatten: true }, remaining());
        if (typeof result.sessionId !== "string") throw new CloudBrowserError("provider_page_missing", "AgentCore did not expose a page session.");
        return result.sessionId;
      };
      const sync = (): void => {
        session.ownedTargetIds = [...context.ownedTargetIds];
        session.selectedTargetId = context.selectedTargetId;
      };
      if (action.type === "tab_create" || action.type === "tab_select" || action.type === "tab_close" || action.type === "navigate_back" || action.type === "navigate_forward" || action.type === "reload" || action.type === "focus" || action.type === "select" || action.type === "dialog") {
        try {
          const receipt = await controller.execute(action, remaining);
          let finalReceipt = receipt;
          if (action.type === "tab_create" && context.selectedTargetId === null && receipt.createdTargetId) {
            try {
              await cdp.command("Target.activateTarget", { targetId: receipt.createdTargetId }, remaining());
              context.selectedTargetId = receipt.createdTargetId;
              finalReceipt = {
                ...receipt,
                selectedTargetId: receipt.createdTargetId,
              };
            } catch {
              session.effectUnknown = true;
              throw new CloudBrowserError("target_select_uncertain", "The new tab was created, but its selection result is uncertain; reconcile before continuing.");
            }
          }
          sync();
          return { observation: null, pageReceipt: finalReceipt };
        } catch (error) {
          if (action.type === "tab_create" && error instanceof CloudBrowserError && error.code === "target_create_uncertain") session.effectUnknown = true;
          if (action.type === "tab_close") session.effectUnknown = !(error instanceof CloudBrowserError && error.code === "target_operation_failed");
          if (action.type === "tab_select" && error instanceof CloudBrowserError && ["provider_action_failed", "provider_timeout"].includes(error.code)) {
            session.effectUnknown = true;
            throw new CloudBrowserError("target_select_uncertain", "The tab selection result is uncertain; reconcile before continuing.");
          }
          throw error;
        }
      }
      const page = await attach(selected());
      if (action.type === 'upload') {
        if (!this.uploadFileResolver) {
          session.effectUnknown = false;
          throw new CloudBrowserError('file_transfer_unavailable', 'Browser file upload is unavailable.');
        }
        let file: Awaited<ReturnType<BrowserFileResolver>>;
        try {
          file = await this.uploadFileResolver(session.owner, action.fileId);
        } catch {
          // The trusted resolver failed before any file was assigned or input event dispatched.
          session.effectUnknown = false;
          throw new CloudBrowserError('file_unavailable', 'Staged file is unavailable for browser transfer.');
        }
        try {
          const fileReceipt = await attachStagedFileToOwnedInput({
            caller: session.owner,
            session,
            targetId: selected(),
            pageSessionId: page,
            selector: action.selector,
            file,
            cdp,
            timeoutMs: remaining(),
          });
          return { observation: null, fileReceipt };
        } catch (error) {
          if (error instanceof CloudBrowserError && error.code === 'file_transfer_uncertain') session.effectUnknown = true;
          else if (error instanceof CloudBrowserError) session.effectUnknown = false;
          throw error;
        }
      }
      if (action.type === 'capture') {
        const tree = await cdp.command('Accessibility.getFullAXTree', {}, remaining(), page);
        const nodes = tree.nodes as Array<{ role?: { value?: unknown }; name?: { value?: unknown } }> | undefined;
        const sensitiveControl = nodes?.some(node => {
          const role = typeof node.role?.value === 'string' ? node.role.value.toLowerCase() : '';
          const name = typeof node.name?.value === 'string' ? node.name.value : '';
          return role === 'password' || /\b(?:captcha|one[- ]time (?:password|code)|verification code|security code|authenticator code)\b/i.test(name);
        }) ?? false;
        if (sensitiveControl) throw new CloudBrowserError('sensitive_output_denied', 'Browser capture is unavailable while a password or verification control is present.');
        const capture = await captureBrowserArtifact(cdp, page, action.request, remaining, this.captureValidator);
        sync();
        return { observation: null, capture };
      }
      if (action.type === "snapshot") {
        const history = await cdp.command("Page.getNavigationHistory", {}, remaining(), page);
        const entries = history.entries as Array<{ url?: unknown; title?: unknown }> | undefined;
        const current = entries?.[typeof history.currentIndex === "number" ? history.currentIndex : -1];
        const tree = await cdp.command("Accessibility.getFullAXTree", {}, remaining(), page);
        const names =
          (
            tree.nodes as
              | Array<{
                  name?: { value?: unknown };
                  role?: { value?: unknown };
                }>
              | undefined
          )
            ?.filter((node) => node.role?.value !== "password")
            .map((node) => node.name?.value)
            .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .join(" ")
            .slice(0, 4_000) ?? "";
        sync();
        return {
          url: typeof current?.url === "string" ? current.url : null,
          title: typeof current?.title === "string" ? current.title.slice(0, 300) : null,
          visibleText: names,
        };
      }
      if (action.type === "navigate") {
        await cdp.command("Page.navigate", { url: action.url }, remaining(), page);
        sync();
        return null;
      }
      await executeCloudBrowserInteraction(cdp, page, action, remaining);
      sync();
      return null;
    } finally {
      cdp.close();
    }
  }
  async stop(session: CloudBrowserSession): Promise<void> {
    const browserId = session.providerBrowserId ?? (session.mode === "public_web" ? undefined : BROWSER_ID);
    if (!browserId) throw new CloudBrowserError("provider_browser_id_missing", "Public session is missing its original browser resource identifier.");
    const credentials = await resolveAwsCredentials();
    if (!credentials) throw new CloudBrowserError("aws_credentials_unavailable", "Cloud browser runtime credentials are unavailable.");
    const host = `bedrock-agentcore.${this.region}.amazonaws.com`;
    const path = `/browsers/${encodeURIComponent(browserId)}/sessions/stop`;
    const query = { sessionId: session.providerSessionId };
    const body = JSON.stringify({ clientToken: randomUUID() });
    const signed = signRequest({
      method: "PUT",
      host,
      path,
      query,
      body,
      region: this.region,
      service: "bedrock-agentcore",
      credentials,
      extraHeaders: { "content-type": "application/json" },
    });
    const response = await this.fetchImpl(`https://${host}${path}?sessionId=${encodeURIComponent(session.providerSessionId)}`, {
      method: "PUT",
      headers: signed.headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new CloudBrowserError(`provider_stop_${response.status}`, `AgentCore stop request failed with HTTP ${response.status}.`);
  }
  async saveProfile(session: CloudBrowserSession, profile: CloudBrowserProfile): Promise<void> {
    if (!profile.providerProfileId) throw new CloudBrowserError("profile_not_persistent", "No provider profile is configured.");
    const browserId = session.providerBrowserId ?? (session.mode === "public_web" ? undefined : BROWSER_ID);
    if (!browserId) throw new CloudBrowserError("provider_browser_id_missing", "Public session is missing its original browser resource identifier.");
    const credentials = await resolveAwsCredentials();
    if (!credentials) throw new CloudBrowserError("aws_credentials_unavailable", "Cloud browser runtime credentials are unavailable.");
    const saved = await this.request(
      "PUT",
      `/browser-profiles/${encodeURIComponent(profile.providerProfileId)}/save`,
      {
        browserIdentifier: browserId,
        sessionId: session.providerSessionId,
        clientToken: randomUUID(),
      },
      credentials,
    ) as {profileIdentifier?:unknown; browserIdentifier?:unknown; sessionId?:unknown; lastUpdatedAt?:unknown};
    if (saved.profileIdentifier !== profile.providerProfileId || saved.browserIdentifier !== browserId || saved.sessionId !== session.providerSessionId || typeof saved.lastUpdatedAt !== 'string' || !Number.isFinite(Date.parse(saved.lastUpdatedAt))) {
      throw new CloudBrowserError('profile_save_receipt_invalid','The provider did not confirm the exact owned profile/session save.');
    }
  }
}


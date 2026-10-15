import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, type CallerHashProvider, type ToolResultPayload } from "../registry.js";
import { CLOUD_BROWSER_LEGACY_MAX_SESSION_SECONDS, CLOUD_BROWSER_MAX_SESSION_SECONDS, type CloudBrowserAction } from "../browser-cloud/contract.js";
import { cloudBrowserActionSchema } from "../browser-cloud/actions.js";
import type { BrowserCaptureMetadata } from '../browser-cloud/contract.js';
import { CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS } from "../browser-cloud/service.js";
import { CloudBrowserJobs, type CloudBrowserArtifactStore, type CloudBrowserWorkerQueue } from "../browser-cloud-jobs/contracts.js";
import { CloudBrowserJobWorker, type CloudBrowserPlanExecutor } from "../browser-cloud-jobs/worker.js";
import { validBrowserFileScanReceipt, type BrowserFileBroker } from '../browser-cloud/file-broker.js';
import type { BrowserFileTransferReceipt } from '../browser-cloud/provider-files.js';
import { DaytonaBrowserError } from '../browser-daytona/contract.js';
import type { DaytonaBrowserService } from '../browser-daytona/service.js';
import type { DaytonaViewerHandoffService } from '../../server/daytona-viewer-service.js';

import { currentIntercomPrincipalKey } from '../browser-cloud/intercom-login-service.js';
import { websitePrincipalHash, type WebsiteLoginService } from '../browser-cloud/website-login-service.js';
function principalHash(caller: string): string | undefined {
  const subject = currentIntercomPrincipalKey();
  return (CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS as readonly string[]).includes(caller) && subject ? websitePrincipalHash(caller, subject) : undefined;
}
const actionSchema = cloudBrowserActionSchema;
const planSchema = z
  .object({
    profile_id: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/),
    max_seconds: z.number().int().min(1).max(CLOUD_BROWSER_LEGACY_MAX_SESSION_SECONDS),
    actions: z
      .array(
        z.discriminatedUnion("type", [
          z.object({
            type: z.literal("navigate"),
            url: z.string().url().max(2048),
          }),
          z.object({
            type: z.literal("wait_for"),
            selector: z.string().min(1).max(256),
          }),
        ]),
      )
      .min(1)
      .max(10_000),
  })
  .strict();
type DeterministicPlan = z.infer<typeof planSchema>;

export function redactCloudBrowserInputForLog(input: Record<string, unknown>): unknown {
  const copy = { ...input };
  if (copy.action !== undefined) copy.action = "[redacted browser action]";
  if (copy.plan !== undefined) copy.plan = "[redacted browser plan]";
  if (copy.text !== undefined || copy.url !== undefined || copy.selector !== undefined) return { operation: "browser_cloud", input: "[redacted browser input]" };
  return copy;
}
/** Shield scans may inspect operation metadata only. Typed text, URLs and selectors are never sent. */
export function shieldCloudBrowserInput(input: Record<string, unknown>): unknown {
  return {
    operation: "browser_cloud",
    fields: Object.keys(input)
      .filter((key) => !["action", "plan", "text", "url", "selector"].includes(key))
      .sort(),
  };
}
export function validateDeterministicPlan(value: unknown): DeterministicPlan {
  return planSchema.parse(value);
}
export function cloudBrowserRuntimeStatus(): {
  enabled: boolean;
  reason?: string;
} {
  return process.env.CLOUD_BROWSER_ENABLED === "true" && !!process.env.CLOUD_BROWSER_DDB_TABLE && !!process.env.CLOUD_BROWSER_QUEUE_URL && !!process.env.CLOUD_BROWSER_ARTIFACT_BUCKET
    ? { enabled: true }
    : {
        enabled: false,
        reason: "Cloud browser is disabled or its durable DynamoDB table, SQS queue, and S3 artifact bucket are not configured.",
      };
}
function unavailable(): ToolResultPayload {
  const state = cloudBrowserRuntimeStatus();
  return {
    data: { error: "cloud_browser_not_configured" },
    summary: state.reason ?? "Cloud browser runtime is unavailable.",
  };
}
function error(error: unknown): ToolResultPayload {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "cloud_browser_failed";
  return {
    data: { error: code },
    summary: `Cloud browser request was not completed: ${code}.`,
  };
}

/** `snapshot` is intentionally metadata-only and is supplied by the session-core owner. */
export interface CloudBrowserGatewayService {
  start(caller: string, profileId: string, maxSeconds: number, actionBudget?: number, principalHash?: string): Promise<{ sessionId: string; expiresAt: number }>;
  execute(caller: string, sessionId: string, action: CloudBrowserAction, timeoutSeconds: number, principalHash?: string): Promise<unknown>;
  stop(caller: string, sessionId: string, principalHash?: string): Promise<void>;
  savePersistentProfile(caller: string, sessionId: string, principalHash?: string): Promise<void>;
  snapshot(caller: string, sessionId: string, principalHash?: string): Promise<unknown>;
  getCapture?(caller: string, captureId: string, principalHash?: string): Promise<{
    metadata: BrowserCaptureMetadata;
    body: Uint8Array;
  }>;
  publicTrialProfile(caller: string, principalHash?: string): Promise<{
    profileId: string;
    allowedHosts: readonly string[];
    persistent: boolean;
  }>;
  publicWebProfile(caller: string, principalHash?: string): Promise<{
    profileId: string;
    allowedHosts: readonly string[];
    persistent: boolean;
    mode?: string;
    actionBudget?: number;
    maxSessionSeconds?: number;
    maxActionSeconds?: number;
  }>;
  provisionPublicTrialProfile(caller: string, owner: string, allowedHosts: readonly string[]): Promise<{ profileId: string; owner: string; allowedHosts: readonly string[]; persistent: boolean }>;
}
export interface CloudBrowserGatewayRuntime {
  browser: CloudBrowserGatewayService;
  jobs: CloudBrowserJobs;
  queue: CloudBrowserWorkerQueue;
  artifacts: CloudBrowserArtifactStore;
  files?: Pick<BrowserFileBroker, 'stage' | 'get'>;
}
export interface DaytonaGatewayRuntime {
  capabilities: Readonly<{ checkpoint: boolean; humanViewer: boolean }>;
  browser: Pick<DaytonaBrowserService, 'discover' | 'readiness' | 'start' | 'execute' | 'snapshot' | 'savePersistentProfile' | 'stop'>;
  viewers: Pick<DaytonaViewerHandoffService, 'issue'>;
}
/** A consistent server-store lookup, never an untrusted provider hint, selects UUID routing. */
export interface DaytonaGatewayAdapter {
  get(): Promise<DaytonaGatewayRuntime | undefined>;
  forSession(sessionId: string): Promise<DaytonaGatewayRuntime | undefined>;
}
/** Register narrow MCP tools. Owner identity always comes from ToolContext.callerAgent. */
export function registerCloudBrowserTools(server: McpServer, callerHash: CallerHashProvider, runtime: CloudBrowserGatewayRuntime,
  websiteLoginRuntime?: () => Pick<WebsiteLoginService, 'start' | 'discover'>, daytona?: DaytonaGatewayAdapter): void {
  const live = () => cloudBrowserRuntimeStatus().enabled;
  const daytonaPrincipal = (caller: string): string => {
    if (!(CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS as readonly string[]).includes(caller)) throw new DaytonaBrowserError('company_connection_required');
    const principal = principalHash(caller);
    if (!principal) throw new DaytonaBrowserError('oauth_connection_required');
    return principal;
  };
  const sessionBackend = async (sessionId: string, caller: string) => {
    const desktop = await daytona?.forSession(sessionId);
    if (desktop) return { browser: desktop.browser, principal: daytonaPrincipal(caller) };
    // A lookup or ownership error is never caught here and cannot select AWS.
    if (!live()) throw new DaytonaBrowserError('cloud_browser_not_configured');
    return { browser: runtime.browser, principal: principalHash(caller) };
  };
  const websiteProfiles = async (caller: string) => {
    const key = currentIntercomPrincipalKey();
    if (!websiteLoginRuntime || !key || !(CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS as readonly string[]).includes(caller)) return undefined;
    return Promise.all((['linkedin', 'wefunder'] as const).map(async site => {
      const base = { site, login_profile_id: `website-login:${site}` };
      try {
        const saved = await websiteLoginRuntime().discover(caller, key, site);
        return { ...base, saved_profile_id: saved.profile_id, status: 'saved_profile_available' };
      } catch (e) {
        const missing = e && typeof e === 'object' && 'code' in e && e.code === 'profile_not_enrolled';
        return { ...base, status: missing ? 'login_required' : 'unavailable' };
      }
    }));
  };
  const websiteProfilesSchema = z.array(z.object({
    site: z.enum(['linkedin', 'wefunder']), login_profile_id: z.string(),
    saved_profile_id: z.string().optional(), status: z.enum(['saved_profile_available', 'login_required', 'unavailable']),
  })).optional();
  registerTool(server, {
    name: 'browser_cloud_file_stage', category: 'write_simple',
    annotations: { title: 'Cloud browser: stage an owned upload file', description: 'Stages bounded file bytes privately for this caller. Validated UTF-8 text can be attached to a file input; binary files remain quarantined without a configured scanner. Staging is not a completed website upload.', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputShape: { filename: z.string().min(1).max(128), content_type: z.enum(['text/plain', 'text/csv', 'application/pdf', 'image/png', 'image/jpeg']), body_base64: z.string().min(4).max(4_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) },
    outputShape: { file_id: z.string().optional(), status: z.enum(['ready', 'quarantined', 'partial']).optional(), content_type: z.string().optional(), byte_length: z.number().optional(), sha256: z.string().optional(), expires_at: z.number().optional(), scan_receipt: z.object({ verdict: z.literal('clean'), scanner: z.literal('clamav'), sha256: z.string(), byteLength: z.number(), scannedAt: z.number(), engineVersion: z.string(), signatureVersion: z.string(), signaturesUpdatedAt: z.number() }).strict().optional(), error: z.string().optional() },
    redactInputForLog: () => ({ operation: 'browser_cloud_file_stage', input: '[redacted file bytes and metadata]' }),
    shieldInputForScan: () => ({ operation: 'browser_cloud_file_stage' }),
    handler: async (input, ctx) => {
      if (!live()) return unavailable();
      if (ctx.dryRun) return { data: { dry_run: true }, summary: 'File staging was not executed.' };
      if (!runtime.files) return { data: { error: 'file_store_unavailable' }, summary: 'Browser file storage is not configured.' };
      try {
        const body = Buffer.from(input.body_base64, 'base64');
        if (body.toString('base64') !== input.body_base64) return { data: { error: 'invalid_file_encoding' }, summary: 'File bytes must have a canonical encoding.' };
        const record = await runtime.files.stage(ctx.callerAgent, { filename: input.filename, contentType: input.content_type, body }, principalHash(ctx.callerAgent));
        const scanned = validBrowserFileScanReceipt(record.scanReceipt, record.sha256, record.byteLength);
        return { data: { file_id: record.id, status: record.status, content_type: record.contentType, byte_length: record.byteLength, sha256: record.sha256, expires_at: record.expiresAt, ...(scanned ? { scan_receipt: record.scanReceipt } : {}) }, summary: record.status === 'ready' ? (scanned ? 'Owner-bound file staged with a verified exact-byte ClamAV scan receipt. Website upload is not yet completed.' : 'Owner-bound file staged for browser attachment. No antivirus verdict or completed website upload is claimed.') : 'File staged privately in quarantine; it is not cleared for browser attachment or a completed website upload.' };
      } catch (e) { return error(e); }
    },
  }, callerHash);
  registerTool(
    server,
    {
      name: "browser_cloud_profile_discover",
      category: "read",
      annotations: { title: "Cloud browser: discover my browser profile", description: "Returns the authenticated caller's public profile and own saved website profile IDs. Named website-login:linkedin and website-login:wefunder profiles can start human sign-in through the existing session-start tool. Discovery creates no browser or login session.", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputShape: {},
      outputShape: { profile_id: z.string().optional(), allowed_hosts: z.array(z.string()).optional(), persistent: z.boolean().optional(), website_profiles: websiteProfilesSchema, error: z.string().optional() },
      handler: async (_input, ctx) => {
        if (!live()) return unavailable();
        const websites = await websiteProfiles(ctx.callerAgent);
        try {
          const profile = await runtime.browser.publicTrialProfile(ctx.callerAgent, principalHash(ctx.callerAgent));
          return { data: { profile_id: profile.profileId, allowed_hosts: profile.allowedHosts, persistent: profile.persistent, ...(websites ? { website_profiles: websites } : {}) }, summary: "Returned this caller's public profile and available owned website profiles; no login or session was started." };
        } catch (e) {
          const failure = error(e);
          return { ...failure, data: { ...failure.data as Record<string, unknown>, ...(websites ? { website_profiles: websites } : {}) } };
        }
      },
    },
    callerHash,
  );
  registerTool(
    server,
    {
      name: "browser_cloud_profile_provision_public_trial",
      category: "write_simple",
      annotations: { title: "Cloud browser: provision legacy public trial profile", description: "CTO-only. Creates or updates a non-persistent, per-host legacy profile for one eligible company lane. It cannot enroll a public-web profile.", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputShape: { owner_agent: z.enum(CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS), allowed_hosts: z.array(z.string().min(1).max(253)).min(1).max(24) },
      outputShape: { profile_id: z.string().optional(), owner_agent: z.string().optional(), allowed_hosts: z.array(z.string()).optional(), persistent: z.boolean().optional(), dry_run: z.boolean().optional(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!live()) return unavailable();
        if (ctx.dryRun) return { data: { dry_run: true }, summary: "Legacy public trial profile provisioning was not executed." };
        try {
          const profile = await runtime.browser.provisionPublicTrialProfile(ctx.callerAgent, input.owner_agent, input.allowed_hosts);
          return { data: { profile_id: profile.profileId, owner_agent: profile.owner, allowed_hosts: profile.allowedHosts, persistent: profile.persistent }, summary: "Legacy enrolled-host profile provisioned with owner isolation." };
        } catch (e) {
          return error(e);
        }
      },
    },
    callerHash,
  );
  registerTool(
    server,
    {
      name: "browser_cloud_public_web_profile_discover",
      category: "read",
      annotations: {
        title: "Cloud browser: discover my public-web profile",
        description: "Returns the authenticated caller's root-enrolled public-web profile for HTTP and HTTPS destinations without per-domain enrollment. Traffic uses its isolated egress policy, and session/mission budgets remain server configured.",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {},
      outputShape: {
        profile_id: z.string().optional(),
        mode: z.string().optional(),
        allowed_hosts: z.array(z.string()).optional(),
        persistent: z.boolean().optional(),
        action_budget_limit: z.number().optional(),
        max_session_seconds: z.number().optional(),
        max_action_seconds: z.number().optional(),
        website_profiles: websiteProfilesSchema,
        error: z.string().optional(),
      },
      handler: async (_input, ctx) => {
        if (!live()) return unavailable();
        const websites = await websiteProfiles(ctx.callerAgent);
        try {
          const profile = await runtime.browser.publicWebProfile(ctx.callerAgent, principalHash(ctx.callerAgent));
          return {
            data: {
              profile_id: profile.profileId,
              mode: profile.mode,
              allowed_hosts: profile.allowedHosts,
              persistent: profile.persistent,
              action_budget_limit: profile.actionBudget,
              max_session_seconds: profile.maxSessionSeconds,
              max_action_seconds: profile.maxActionSeconds,
              ...(websites ? { website_profiles: websites } : {}),
            },
            summary: "Returned this caller's server-enrolled public-web profile.",
          };
        } catch (e) {
          const failure = error(e);
          return { ...failure, data: { ...failure.data as Record<string, unknown>, ...(websites ? { website_profiles: websites } : {}) } };
        }
      },
    },
    callerHash,
  );
  registerTool(
    server,
    {
      name: "browser_cloud_job_submit",
      category: "write_simple",
      annotations: {
        title: "Cloud browser: submit bounded job",
        description: "Persists a deterministic read-only cloud browser plan. Owner identity is the authenticated caller.",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        idempotency_key: z.string().min(8).max(255),
        plan: z.unknown(),
      },
      outputShape: {
        job_id: z.string().optional(),
        replayed: z.boolean().optional(),
        error: z.string().optional(),
      },
      redactInputForLog: redactCloudBrowserInputForLog,
      shieldInputForScan: shieldCloudBrowserInput,
      handler: async (input, ctx) => {
        if (!live()) return unavailable();
        if (ctx.dryRun) {
          validateDeterministicPlan(input.plan);
          return {
            data: { dry_run: true },
            summary: "Validated deterministic plan. No job was created.",
          };
        }
        try {
          const out = await runtime.jobs.submit({
            agent: ctx.callerAgent,
            ownerSubjectHash: principalHash(ctx.callerAgent),
            idempotencyKey: input.idempotency_key,
            request: validateDeterministicPlan(input.plan),
          });
          return {
            data: {
              job_id: out.job.id,
              replayed: out.replayed,
              status: out.job.status,
            },
            summary: out.replayed ? "Returned the existing durable browser job." : "Created a durable browser job.",
          };
        } catch (e) {
          return error(e);
        }
      },
    },
    callerHash,
  );
  registerTool(
    server,
    {
      name: "browser_cloud_job_get",
      category: "read",
      annotations: {
        title: "Cloud browser: get job",
        description: "Reads an authenticated caller’s durable browser job without request text.",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: { job_id: z.string().max(128) },
      outputShape: {
        job: z.unknown().optional(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!live()) return unavailable();
        try {
          const job = await runtime.jobs.get(input.job_id, ctx.callerAgent, principalHash(ctx.callerAgent));
          const { request: _request, ownerSubjectHash: _principal, ...safe } = job;
          return {
            data: { job: safe },
            summary: `Browser job ${job.id} is ${job.status}.`,
          };
        } catch (e) {
          return error(e);
        }
      },
    },
    callerHash,
  );
  registerTool(
    server,
    {
      name: "browser_cloud_artifact_get",
      category: "read",
      annotations: {
        title: "Cloud browser: get artifact",
        description: "Reads an authenticated caller’s bounded immutable job artifact or browser capture. For a capture, job_id is the original session_id and artifact_id is its capture_id.",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        job_id: z.string().max(128),
        artifact_id: z.string().max(128),
      },
      outputShape: {
        artifact: z.unknown().optional(),
        error: z.string().optional(),
      },
      maxResponseBytes: 6_000_000,
      handler: async (input, ctx) => {
        if (!live()) return unavailable();
        try {
          if (input.artifact_id.startsWith('bca_')) {
            if (!runtime.browser.getCapture) throw Object.assign(new Error('capture_unavailable'), { code: 'capture_unavailable' });
            const capture = await runtime.browser.getCapture(ctx.callerAgent, input.artifact_id, principalHash(ctx.callerAgent));
            const metadata = capture.metadata;
            if (
              metadata.id !== input.artifact_id ||
              metadata.owner !== ctx.callerAgent ||
              metadata.sessionId !== input.job_id ||
              !Number.isSafeInteger(metadata.byteLength) ||
              metadata.byteLength < 1 ||
              metadata.byteLength > 4 * 1024 * 1024 ||
              capture.body.byteLength !== metadata.byteLength ||
              !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
              createHash('sha256').update(capture.body).digest('hex') !== metadata.sha256
            ) {
              return {
                data: { error: 'capture_integrity_failed' },
                summary: 'Capture integrity or session binding validation failed.',
              };
            }
            const base64 = Buffer.from(capture.body).toString('base64');
            const nativeContent = metadata.contentType === 'image/png' || metadata.contentType === 'image/jpeg'
              ? [{ type: 'image' as const, data: base64, mimeType: metadata.contentType }]
              : metadata.contentType === 'application/pdf'
                ? [{ type: 'resource' as const, resource: {
                    uri: `browser-capture://${metadata.id}`,
                    mimeType: 'application/pdf',
                    blob: base64,
                  } }]
                : null;
            if (!nativeContent) {
              return { data: { error: 'capture_integrity_failed' }, summary: 'Capture content type is unsupported.' };
            }
            return {
              data: {
                artifact: {
                  id: metadata.id,
                  session_id: metadata.sessionId,
                  content_type: metadata.contentType,
                  byte_length: metadata.byteLength,
                  sha256: metadata.sha256,
                  ...(metadata.pageCount === undefined ? {} : { page_count: metadata.pageCount }),
                },
              },
              nativeContent,
              summary: 'Owner-bound browser capture returned as native MCP image or PDF content.',
            };
          }
          const job = await runtime.jobs.get(input.job_id, ctx.callerAgent, principalHash(ctx.callerAgent));
          const artifact = job.artifacts.find((item) => item.id === input.artifact_id);
          if (!artifact)
            return {
              data: { error: "artifact_not_found" },
              summary: "Artifact is unavailable to this caller.",
            };
          const value = await runtime.artifacts.getVersion({
            key: artifact.storageKey,
            version: artifact.storageVersion,
            maxBytes: 1_000_000,
          });
          const actual = createHash("sha256").update(value.body).digest("hex");
          if (actual !== artifact.sha256)
            return {
              data: { error: "artifact_integrity_failed" },
              summary: "Artifact integrity validation failed.",
            };
          return {
            data: {
              artifact: {
                id: artifact.id,
                content_type: value.contentType,
                text: value.body.toString("utf8"),
              },
            },
            summary: "Immutable job artifact returned.",
          };
        } catch (e) {
          return error(e);
        }
      },
    },
    callerHash,
  );
  registerTool(
    server,
    {
      name: "browser_cloud_job_cancel",
      category: "write_simple",
      annotations: {
        title: "Cloud browser: cancel job",
        description: "Requests cancellation of the authenticated caller’s queued or running job.",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: { job_id: z.string().max(128) },
      outputShape: {
        status: z.string().optional(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!live()) return unavailable();
        if (ctx.dryRun)
          return {
            data: { dry_run: true },
            summary: "Cancellation was not requested.",
          };
        try {
          const job = await runtime.jobs.requestCancellation(input.job_id, ctx.callerAgent, principalHash(ctx.callerAgent));
          return {
            data: { status: job.status },
            summary: "Cancellation state was saved.",
          };
        } catch (e) {
          return error(e);
        }
      },
    },
    callerHash,
  );
  registerTool(
    server,
    {
      name: "browser_cloud_session_start",
      category: "write_simple",
      annotations: {
        title: "Cloud browser: start session",
        description: "Starts an authenticated caller's browser within requested budgets. The opt-in daytona-company profile starts automation only when this OAuth connection's exact root-enrolled company browser proves V2 multi-mission readiness; it never opens a human viewer. The daytona-desktop profile requires configured human-viewer revocation and checkpoint support. The named profiles website-login:linkedin and website-login:wefunder retain the connection-bound AWS human sign-in flow. Open a returned login_url, confirm the signed-in account and click Done. Other profile IDs retain normal AWS session behavior.",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        profile_id: z.string().max(64),
        max_seconds: z.number().int().min(1).max(CLOUD_BROWSER_MAX_SESSION_SECONDS),
        action_budget: z.number().int().positive().optional(),
      },
      outputShape: {
        sessionId: z.string().optional(),
        expiresAt: z.number().optional(),
        profile_id: z.string().optional(),
        login_url: z.string().optional(),
        login_expires_at: z.number().optional(),
        status: z.enum(['human_login_required', 'ready']).optional(),
        provider: z.literal('daytona').optional(),
        runtime_protocol: z.literal(2).optional(),
        error: z.string().optional(),
      },
      ephemeralOutput: true,
      redactInputForLog: redactCloudBrowserInputForLog,
      shieldInputForScan: shieldCloudBrowserInput,
      redactResultForLog: () => ({ operation: 'browser_cloud_session_start', result: '[redacted browser session]' }),
      handler: async (input, ctx) => {
        if (!live() && input.profile_id !== 'daytona-desktop' && input.profile_id !== 'daytona-company') return unavailable();
        if (ctx.dryRun)
          return {
            data: { dry_run: true },
            summary: "Session start was not executed.",
          };
        try {
          if (input.profile_id === 'daytona-company') {
            const principal = daytonaPrincipal(ctx.callerAgent);
            const company = await daytona?.get();
            if (!company) throw new DaytonaBrowserError('daytona_not_configured');
            const profile = await company.browser.discover(ctx.callerAgent, principal);
            const readiness = await company.browser.readiness(ctx.callerAgent, profile.profileId, principal);
            if (readiness.ready !== true || readiness.profileKey !== profile.profileId || readiness.runtimeProtocol !== 2 || readiness.multiMissionReady !== true) throw new DaytonaBrowserError('daytona_multimission_unavailable');
            // The service must re-probe at the effect boundary and forbid a V1
            // fallback if readiness changed after the gateway's observation.
            const started = await company.browser.start(ctx.callerAgent, profile.profileId, input.max_seconds, input.action_budget, principal, { requireMultiMission: true });
            if (started.runtimeProtocol !== 2) throw new DaytonaBrowserError('daytona_multimission_unavailable');
            return { data: { sessionId: started.sessionId, expiresAt: started.expiresAt, profile_id: 'daytona-company', provider: 'daytona', runtime_protocol: 2, status: 'ready' }, summary: 'Owned company-browser automation mission started with confirmed V2 runtime routing. No human viewer or AWS session was created.' };
          }
          if (input.profile_id === 'daytona-desktop') {
            const principal = daytonaPrincipal(ctx.callerAgent);
            const desktop = await daytona?.get();
            if (!desktop) throw new DaytonaBrowserError('daytona_not_configured');
            if (desktop.capabilities.humanViewer !== true) throw new DaytonaBrowserError('daytona_handoff_unavailable');
            const profile = await desktop.browser.discover(ctx.callerAgent, principal);
            const readiness = await desktop.browser.readiness(ctx.callerAgent, profile.profileId, principal);
            if (readiness.ready !== true || readiness.profileKey !== profile.profileId || readiness.checkpointReady !== true) throw new DaytonaBrowserError('daytona_handoff_unavailable');
            const started = await desktop.browser.start(ctx.callerAgent, profile.profileId, input.max_seconds, input.action_budget, principal);
            const handoff = await desktop.viewers.issue(ctx.callerAgent, started.sessionId, principal, Math.min(300, input.max_seconds));
            return { data: { ...started, profile_id: 'daytona-desktop', provider: 'daytona', login_url: handoff.login_url, login_expires_at: handoff.expires_at, status: 'human_login_required' }, summary: 'Owned Daytona desktop mission started. Open the short-lived private viewer, confirm the signed-in account and click Done to release human control. No AWS session was created.' };
          }
          if (input.profile_id.startsWith('website-login:')) {
            const site = input.profile_id === 'website-login:linkedin' ? 'linkedin'
              : input.profile_id === 'website-login:wefunder' ? 'wefunder' : undefined;
            if (!site) return { data: { error: 'website_login_profile_invalid' }, summary: 'Choose the named LinkedIn or WeFunder login profile.' };
            if (!(CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS as readonly string[]).includes(ctx.callerAgent)) return { data: { error: 'company_connection_required' }, summary: 'Use an eligible authenticated company connection.' };
            const key = currentIntercomPrincipalKey();
            if (!key) return { data: { error: 'oauth_connection_required' }, summary: 'Website sign-in requires this company connection\'s OAuth binding.' };
            if (!websiteLoginRuntime) return { data: { error: 'website_login_unavailable' }, summary: 'Website sign-in is not configured.' };
            const login = await websiteLoginRuntime().start(ctx.callerAgent, key, site, undefined, { maxSeconds: input.max_seconds, actionBudget: input.action_budget });
            return {
              data: { sessionId: login.session_id, expiresAt: login.session_expires_at, profile_id: login.profile_id,
                login_url: login.login_url, login_expires_at: login.expires_at, status: login.status },
              summary: 'Open the sign-in link, complete login in its browser window, then click Done. Reopen the returned real profile_id in a new session and verify the intended signed-in account.',
            };
          }
          return {
            data: await runtime.browser.start(ctx.callerAgent, input.profile_id, input.max_seconds, input.action_budget, principalHash(ctx.callerAgent)),
            summary: "Cloud browser session started.",
          };
        } catch (e) {
          return error(e);
        }
      },
    },
    callerHash,
  );
  registerTool(
    server,
    {
      name: "browser_cloud_session_action",
      category: "write_simple",
      annotations: {
        title: "Cloud browser: bounded session action",
        description: "Executes one browser action within the session profile's server-configured time and action budgets. It accepts no arbitrary JavaScript.",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        session_id: z.string().max(128),
        action: actionSchema,
        timeout_seconds: z.number().int().min(1).max(CLOUD_BROWSER_MAX_SESSION_SECONDS),
      },
      outputShape: {
        ok: z.boolean().optional(),
        capture_id: z.string().optional(),
        content_type: z.string().optional(),
        byte_length: z.number().optional(),
        sha256: z.string().optional(),
        page_count: z.number().optional(),
        created_target_id: z.string().optional(),
        closed_target_id: z.string().optional(),
        selected_target_id: z.string().nullable().optional(),
        file_id: z.string().optional(),
        file_status: z.literal('attached').optional(),
        error: z.string().optional(),
      },
      redactInputForLog: redactCloudBrowserInputForLog,
      shieldInputForScan: shieldCloudBrowserInput,
      handler: async (input, ctx) => {
        if (!live() && !daytona) return unavailable();
        if (ctx.dryRun)
          return {
            data: { dry_run: true },
            summary: "Browser action was not executed.",
          };
        try {
          const backend = await sessionBackend(input.session_id, ctx.callerAgent);
          const result = await backend.browser.execute(ctx.callerAgent, input.session_id, input.action as CloudBrowserAction, input.timeout_seconds, backend.principal) as {
            createdTargetId?: string;
            closedTargetId?: string;
            selectedTargetId?: string | null;
          } | BrowserCaptureMetadata | null;
          if (input.action.type === 'capture') {
            const capture = result as BrowserCaptureMetadata | null;
            if (!capture || typeof capture.id !== 'string' || capture.owner !== ctx.callerAgent) throw new Error('capture_result_invalid');
            return { data: { ok: true, capture_id: capture.id, content_type: capture.contentType, byte_length: capture.byteLength, sha256: capture.sha256, ...(capture.pageCount === undefined ? {} : { page_count: capture.pageCount }) }, summary: 'Validated browser capture stored as an owner-bound immutable artifact; capture bytes are not returned inline.' };
          }
          if (input.action.type === 'upload') {
            const file = result as BrowserFileTransferReceipt | null;
            if (!file || file.status !== 'attached' || !Number.isSafeInteger(file.byteLength) || file.byteLength < 1 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('file_result_invalid');
            return { data: { ok: true, file_id: input.action.fileId, file_status: 'attached', content_type: file.contentType, byte_length: file.byteLength, sha256: file.sha256 }, summary: 'Staged file attached to the owned browser input and its bytes verified. The website’s final upload completion must be verified separately.' };
          }
          const actionResult = result as { createdTargetId?: string; closedTargetId?: string; selectedTargetId?: string | null } | null;
          return {
            data: {
              ok: true,
              ...(actionResult?.createdTargetId ? { created_target_id: actionResult.createdTargetId } : {}),
              ...(actionResult?.closedTargetId ? { closed_target_id: actionResult.closedTargetId } : {}),
              ...(actionResult && "selectedTargetId" in actionResult ? { selected_target_id: actionResult.selectedTargetId } : {}),
            },
            summary: "Bounded browser action completed.",
          };
        } catch (e) {
          return error(e);
        }
      },
    },
    callerHash,
  );
  for (const [name, method, title] of [
    ["browser_cloud_session_snapshot", "snapshot", "Cloud browser: session snapshot"],
    ["browser_cloud_profile_save", "save", "Cloud browser: save persistent profile"],
    ["browser_cloud_session_stop", "stop", "Cloud browser: stop session"],
  ] as const)
    registerTool(
      server,
      {
        name,
        category: method === "snapshot" ? "read" : "write_simple",
        annotations: {
          title,
          description: method === "snapshot" ? "Returns a bounded page observation for the authenticated session." : "Performs a bounded cloud browser lifecycle operation.",
          readOnlyHint: method === "snapshot",
          destructiveHint: false,
          idempotentHint: method !== "save",
          openWorldHint: false,
        },
        inputShape: { session_id: z.string().max(128) },
        outputShape: {
          ok: z.boolean().optional(),
          session: z.unknown().optional(),
          error: z.string().optional(),
        },
        handler: async (input, ctx) => {
          if (!live() && !daytona) return unavailable();
          try {
            if (method === "snapshot") {
              const backend = await sessionBackend(input.session_id, ctx.callerAgent);
              const session = await backend.browser.snapshot(ctx.callerAgent, input.session_id, backend.principal);
              return {
                data: { session },
                summary: "Bounded cloud browser page observation returned.",
              };
            }
            if (ctx.dryRun)
              return {
                data: { dry_run: true },
                summary: "Lifecycle action was not executed.",
              };
            const backend = await sessionBackend(input.session_id, ctx.callerAgent);
            if (method === "save") await backend.browser.savePersistentProfile(ctx.callerAgent, input.session_id, backend.principal);
            else await backend.browser.stop(ctx.callerAgent, input.session_id, backend.principal);
            return {
              data: { ok: true },
              summary: "Cloud browser lifecycle action completed.",
            };
          } catch (e) {
            return error(e);
          }
        },
      },
      callerHash,
    );
}

export function startCloudBrowserWorker(runtime: CloudBrowserGatewayRuntime): CloudBrowserJobWorker | null {
  if (!cloudBrowserRuntimeStatus().enabled) return null;
  const executor: CloudBrowserPlanExecutor = {
    execute: async (job, control) => {
      const plan = validateDeterministicPlan(job.request);
      const started = await runtime.browser.start(job.agent, plan.profile_id, plan.max_seconds, plan.actions.length + 1, job.ownerSubjectHash);
      try {
        for (let index = 0; index < plan.actions.length; index++) {
          if (control.cancellationRequested()) return;
          const action = plan.actions[index]!;
          const step = `action:${index}`;
          if (await control.heartbeat()) return;
          await control.beginExternalEffect(step);
          await runtime.browser.execute(job.agent, started.sessionId, action, 20, job.ownerSubjectHash);
          await runtime.jobs.recordExternalEffectSucceeded(job.id, job.agent, job.leaseToken, step);
        }
        const observation = await runtime.browser.snapshot(job.agent, started.sessionId, job.ownerSubjectHash);
        const body = Buffer.from(JSON.stringify(observation));
        await runtime.jobs.attachArtifact(job.id, job.agent, job.leaseToken, body, "application/json", createHash("sha256").update(body).digest("hex"));
        return observation;
      } finally {
        await runtime.browser.stop(job.agent, started.sessionId, job.ownerSubjectHash);
      }
    },
  };
  return new CloudBrowserJobWorker(runtime.jobs, runtime.queue, executor);
}

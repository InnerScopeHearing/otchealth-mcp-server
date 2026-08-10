import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { loadEnv } from '../../config/env.js';
import { flyGet, flyWrite } from '../../customerio/fly-client.js';
import { registerTool, type CallerHashProvider, type ToolContext } from '../registry.js';
import {
  CIO_ADMIN_READ_TOOLS,
  CIO_ADMIN_WRITE_TOOLS,
  cioAdminLaneRefusal,
  hasOwnerApprovalReference,
  isCioAdminToolAllowed,
  type CioAdminReadTool,
  type CioAdminWriteTool,
} from './admin-access.js';
import {
  approvalFingerprint,
  redactCioAdminInputForLog,
  redactCioAuditPayload,
} from './admin-redaction.js';
import { getCioDesignReadiness } from './admin-readiness.js';

const CHANNEL_TYPES = ['email', 'twilio', 'sms', 'push', 'in_app', 'line', 'inbox', 'whatsapp'] as const;
const HEALTH_VIEWS = [
  'api_triggered_broadcasts',
  'campaigns',
  'check',
  'cleanup_candidates',
  'delay_history',
  'ingress_breakdown',
  'objects',
  'pipelines',
  'push',
  'segments',
  'top_events',
] as const;

function environmentId(): string {
  return encodeURIComponent(loadEnv().CIO_WORKSPACE_ID);
}

function environmentPath(suffix = ''): string {
  return `/v1/environments/${environmentId()}${suffix}`;
}

interface AdminReadDefinition<Shape extends ZodRawShape> {
  name: CioAdminReadTool;
  title: string;
  description: string;
  inputShape: Shape;
  run: (input: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<unknown>;
}

function registerAdminRead<Shape extends ZodRawShape>(
  server: McpServer,
  callerHash: CallerHashProvider,
  definition: AdminReadDefinition<Shape>,
): void {
  registerTool(server, {
    name: definition.name,
    category: 'read',
    annotations: {
      title: definition.title,
      description: definition.description,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: definition.inputShape,
    outputShape: { result: z.unknown() },
    redactInputForLog: redactCioAdminInputForLog,
    handler: async (input, ctx) => {
      if (!isCioAdminToolAllowed(definition.name, ctx.callerAgent, false)) {
        return cioAdminLaneRefusal(definition.name, ctx.callerAgent, false);
      }
      return { data: await definition.run(input, ctx) };
    },
  }, callerHash);
}

interface AdminWriteDefinition<Shape extends ZodRawShape> {
  name: CioAdminWriteTool;
  title: string;
  description: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  inputShape: Shape;
  destructive: boolean;
  idempotent: boolean;
  path: (input: Record<string, unknown>) => string;
  body?: (input: Record<string, unknown>) => unknown;
  execute?: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

function registerAdminWrite<Shape extends ZodRawShape>(
  server: McpServer,
  callerHash: CallerHashProvider,
  definition: AdminWriteDefinition<Shape>,
): void {
  const inputShape: ZodRawShape = {
    ...definition.inputShape,
    owner_approval_ref: z
      .string()
      .min(8)
      .max(256)
      .optional()
      .describe('Owner approval record, ticket, or decision ID. Required when dry_run=false; never treated as a substitute for the owner approval itself.'),
  };
  registerTool(server, {
    name: definition.name,
    category: 'write_orchestrated',
    annotations: {
      title: definition.title,
      description: `${definition.description} Defaults to dry_run=true. Live execution is limited to cto/exec and requires owner_approval_ref.`,
      readOnlyHint: false,
      destructiveHint: definition.destructive,
      idempotentHint: definition.idempotent,
      openWorldHint: true,
    },
    inputShape,
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      owner_approval_ref_sha256: z.string().nullable(),
      request: z.unknown(),
      result: z.unknown().nullable(),
    },
    redactInputForLog: redactCioAdminInputForLog,
    handler: async (rawInput, ctx) => {
      const input = rawInput as Record<string, unknown>;
      if (!isCioAdminToolAllowed(definition.name, ctx.callerAgent, ctx.dryRun)) {
        return cioAdminLaneRefusal(definition.name, ctx.callerAgent, ctx.dryRun);
      }
      const approvalRef = input.owner_approval_ref;
      if (!ctx.dryRun && !hasOwnerApprovalReference(approvalRef)) {
        return {
          data: {
            executed: false,
            dry_run: false,
            error: 'owner_approval_required',
            owner_approval_ref_sha256: null,
            request: null,
            result: null,
          },
          summary: 'Live Customer.io configuration mutation refused: owner_approval_ref is required.',
        };
      }

      const path = definition.path(input);
      const body = definition.body?.(input);
      const requestReceipt = {
        method: definition.method,
        path,
        body,
      };
      const approvalSha = typeof approvalRef === 'string' ? approvalFingerprint(approvalRef) : null;
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            owner_approval_ref_sha256: approvalSha,
            request: requestReceipt,
            result: null,
          },
          audit: { before: null, after: redactCioAdminInputForLog(input) },
          summary: `DRY RUN: would call Customer.io ${definition.method} ${path}. No provider mutation occurred.`,
        };
      }

      const result = definition.execute
        ? await definition.execute(input, ctx)
        : await flyWrite(definition.method, path, body, { correlationId: ctx.correlationId });
      return {
        data: {
          executed: true,
          dry_run: false,
          owner_approval_ref_sha256: approvalSha,
          request: requestReceipt,
          result,
        },
        audit: { before: null, after: redactCioAdminInputForLog(input) },
        summary: `Customer.io ${definition.method} ${path} completed under owner approval ${approvalSha}.`,
      };
    },
  }, callerHash);
}

const frequencyRuleShape = z.object({
  cap_limit: z.number().int().min(1),
  channels: z.array(z.string().min(1).max(32)).min(1).max(16),
  retry_window_secs: z.number().int().min(0),
  window_secs: z.number().int().min(1),
}).strict();

const goalShape = z.object({
  id: z.number().int().min(0),
  name: z.string().min(1).max(200),
  description: z.string().max(4000),
  attribution_window: z.number().int().min(0),
  funnel_start_event: z.string().min(1).max(255),
  funnel_start_event_type: z.number().int().min(0),
  funnel_time_window_seconds: z.number().int().min(0),
  goal_event: z.string().min(1).max(255),
  goal_event_type: z.number().int().min(0),
  tag_ids: z.array(z.number().int().min(0)).max(100),
  value_type: z.number().int().min(0),
  version: z.number().int().min(0),
  created_at: z.number().int().min(0),
  updated_at: z.number().int().min(0),
  attached_campaigns: z.array(z.number().int().positive()).max(200).nullable().optional(),
  attached_newsletters: z.array(z.number().int().positive()).max(200).nullable().optional(),
  attached_transactional_messages: z.array(z.number().int().positive()).max(200).nullable().optional(),
  attribution_metrics: z.record(z.string()).nullable().optional(),
  currency: z.string().max(16).nullable().optional(),
  value: z.number().nullable().optional(),
  value_attribute: z.string().max(255).nullable().optional(),
  funnel_start_event_filter: z.record(z.unknown()).nullable().optional(),
  goal_event_filter: z.record(z.unknown()).nullable().optional(),
}).strict();

const subscriptionTopicShape = z.object({
  id: z.number().int().min(0),
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  opt_in: z.boolean().nullable().optional(),
}).strict();

const subscriptionLanguageShape = z.object({
  enabled: z.boolean(),
  title: z.string().max(500),
  subtitle: z.string().max(2000),
  channels: z.array(z.object({
    type: z.enum(CHANNEL_TYPES),
    name: z.string().min(1).max(200),
    description: z.string().max(2000),
  }).strict()).max(20),
  topics: z.array(z.object({
    id: z.number().int().min(0),
    name: z.string().min(1).max(200),
    description: z.string().max(2000),
  }).strict()).max(200),
}).strict();

function environmentUpdateBody(current: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  if (!current || typeof current !== 'object') throw new Error('Customer.io environment read returned no object to merge.');
  const root = current as Record<string, unknown>;
  const environment = root.environment;
  if (!environment || typeof environment !== 'object') throw new Error('Customer.io environment response omitted environment.');
  const source = environment as Record<string, unknown>;
  const allowed = [
    'account_id',
    'default_preprocess_css',
    'default_template_engine',
    'delivery_email',
    'delivery_settings',
    'email_open_tracking',
    'hex_code',
    'honor_open_tracking_consent',
    'identifier_settings',
    'identifier_type',
    'identifiers',
    'language_attribute',
    'metric_denominator',
    'name',
    'open_tracking_consent_mode',
    'subscription_center_enabled',
    'users',
  ];
  const projected: Record<string, unknown> = {};
  for (const key of allowed) {
    if (source[key] !== undefined) projected[key] = source[key];
  }
  for (const required of ['account_id', 'identifier_type', 'metric_denominator', 'name', 'users']) {
    if (projected[required] === undefined) throw new Error(`Customer.io environment response omitted required field ${required}.`);
  }
  return { environment: { ...projected, ...patch } };
}

export function registerCioAdminTools(server: McpServer, callerHash: CallerHashProvider): void {
  const readDefinitions: Array<AdminReadDefinition<ZodRawShape>> = [
    {
      name: 'cio_admin_read_workspace_health',
      title: 'Read Customer.io workspace health',
      description: 'Read the schema-backed aggregate environment health summary from GET /v1/environments/{environment_id}/health.',
      inputShape: {},
      run: (_input, ctx) => flyGet(environmentPath('/health'), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_workspace_health_view',
      title: 'Read Customer.io workspace health subview',
      description: 'Read one bounded health subview: campaigns, segments, pipelines, queues, push, objects, delay history, top events, cleanup candidates, or lightweight check.',
      inputShape: { view: z.enum(HEALTH_VIEWS) },
      run: (input, ctx) => flyGet(environmentPath(`/health/${input.view}`), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_frequency_caps',
      title: 'List Customer.io frequency caps',
      description: 'List schema-backed workspace frequency caps from GET /frequency_caps.',
      inputShape: {},
      run: (_input, ctx) => flyGet(environmentPath('/frequency_caps'), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_frequency_cap_usage',
      title: 'Read Customer.io frequency cap usage',
      description: 'Read usage for one frequency cap from GET /frequency_caps/{frequency_cap_id}/usage.',
      inputShape: { frequency_cap_id: z.number().int().positive() },
      run: (input, ctx) => flyGet(environmentPath(`/frequency_caps/${input.frequency_cap_id}/usage`), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_message_limits',
      title: 'Read Customer.io workspace message limits',
      description: 'Read workspace message limits from GET /message_limits.',
      inputShape: {},
      run: (_input, ctx) => flyGet(environmentPath('/message_limits'), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_preserve_unsubscribes_on_merge',
      title: 'Read Customer.io merge unsubscribe policy',
      description: 'Read the preserve-unsubscribes-on-merge setting from GET /preserve_unsubscribes_on_merge.',
      inputShape: {},
      run: (_input, ctx) => flyGet(environmentPath('/preserve_unsubscribes_on_merge'), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_goals',
      title: 'List Customer.io goals',
      description: 'List schema-backed workspace Goals from GET /goals.',
      inputShape: {},
      run: (_input, ctx) => flyGet(environmentPath('/goals'), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_goal',
      title: 'Read a Customer.io goal',
      description: 'Read one Goal by ID from GET /goals/{id}.',
      inputShape: { goal_id: z.number().int().positive() },
      run: (input, ctx) => flyGet(environmentPath(`/goals/${input.goal_id}`), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_goal_data',
      title: 'Read Customer.io goal data',
      description: 'Read the schema-backed Goal data response from GET /goals/{id}/data.',
      inputShape: { goal_id: z.number().int().positive() },
      run: (input, ctx) => flyGet(environmentPath(`/goals/${input.goal_id}/data`), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_subscription_center_settings',
      title: 'Read Customer.io subscription center settings',
      description: 'Read subscription-center style/settings from GET /subscription_center_settings.',
      inputShape: {},
      run: (_input, ctx) => flyGet(environmentPath('/subscription_center_settings'), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_subscription_topics',
      title: 'List Customer.io subscription topics',
      description: 'List subscription topics from GET /subscription_topics.',
      inputShape: {},
      run: (_input, ctx) => flyGet(environmentPath('/subscription_topics'), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_subscription_topic',
      title: 'Read a Customer.io subscription topic',
      description: 'Read one subscription topic from GET /subscription_topics/{topic_id}.',
      inputShape: { topic_id: z.number().int().positive() },
      run: (input, ctx) => flyGet(environmentPath(`/subscription_topics/${input.topic_id}`), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_subscription_channels',
      title: 'List Customer.io subscription channels',
      description: 'List subscription channels from GET /subscription_channels.',
      inputShape: {},
      run: (_input, ctx) => flyGet(environmentPath('/subscription_channels'), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_subscription_languages',
      title: 'List Customer.io subscription languages',
      description: 'List subscription-center languages from GET /subscription_languages.',
      inputShape: {},
      run: (_input, ctx) => flyGet(environmentPath('/subscription_languages'), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_subscription_language',
      title: 'Read a Customer.io subscription language',
      description: 'Read one subscription-center language from GET /subscription_languages/{language_id}.',
      inputShape: { language_id: z.string().min(1).max(32) },
      run: (input, ctx) => flyGet(environmentPath(`/subscription_languages/${encodeURIComponent(input.language_id)}`), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_subscription_pages',
      title: 'List Customer.io subscription pages',
      description: 'List subscription-center pages from GET /subscription_pages.',
      inputShape: {},
      run: (_input, ctx) => flyGet(environmentPath('/subscription_pages'), { correlationId: ctx.correlationId }),
    },
    {
      name: 'cio_admin_read_subscription_order',
      title: 'Read Customer.io subscription order',
      description: 'Read topics and channels together; their ordered API responses are the current order source because the OpenAPI schema exposes only PUT order endpoints.',
      inputShape: {},
      run: async (_input, ctx) => {
        const [topics, channels] = await Promise.all([
          flyGet(environmentPath('/subscription_topics'), { correlationId: ctx.correlationId }),
          flyGet(environmentPath('/subscription_channels'), { correlationId: ctx.correlationId }),
        ]);
        return { topics, channels };
      },
    },
    {
      name: 'cio_admin_read_open_tracking_consent',
      title: 'Read Customer.io open-tracking consent settings',
      description: 'Read email_open_tracking, honor_open_tracking_consent, and open_tracking_consent_mode from the workspace environment.',
      inputShape: {},
      run: async (_input, ctx) => {
        const raw = await flyGet(environmentPath(), { correlationId: ctx.correlationId });
        const environment = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).environment as Record<string, unknown> | undefined : undefined;
        return {
          email_open_tracking: environment?.email_open_tracking ?? null,
          honor_open_tracking_consent: environment?.honor_open_tracking_consent ?? null,
          open_tracking_consent_mode: environment?.open_tracking_consent_mode ?? null,
        };
      },
    },
    {
      name: 'cio_admin_read_audit_logs',
      title: 'Query redacted Customer.io audit logs',
      description: 'List/query workspace audit logs with actor/customer-sensitive fields replaced by deterministic fingerprints.',
      inputShape: {
        limit: z.number().int().min(1).max(100).optional(),
        sort_order: z.enum(['asc', 'desc']).optional(),
        cursor: z.number().int().positive().optional(),
        user_id: z.number().int().positive().optional(),
        service_account_id: z.number().int().positive().optional(),
        ip_addr: z.string().max(128).optional(),
        start_time: z.string().datetime({ offset: true }).optional(),
        end_time: z.string().datetime({ offset: true }).optional(),
        object_type: z.string().max(128).optional(),
        object_id: z.string().max(256).optional(),
        action: z.enum(['created', 'updated', 'deleted']).optional(),
        attribute_name: z.string().max(128).optional(),
        campaign_id: z.number().int().positive().optional(),
        campaign_type: z.enum(['triggered_broadcast', 'exclude_triggered_broadcast']).optional(),
      },
      run: async (input, ctx) => {
        const raw = await flyGet(environmentPath('/audit_logs'), { query: input, correlationId: ctx.correlationId });
        return redactCioAuditPayload(raw);
      },
    },
    {
      name: 'cio_admin_read_design_readiness',
      title: 'Read Customer.io Design Studio readiness',
      description: 'Read one Design Studio email/template and return content-free QA receipts: static accessibility, link/image HTTP status fingerprints, linked/unpublished state, and an explicit unavailable result for spam score when no schema-backed API exists. Never edits or sends content.',
      inputShape: {
        resource_type: z.enum(['design_studio_email', 'template']),
        resource_id: z.string().min(1).max(128),
        check_links: z.boolean().optional().default(true),
      },
      run: (input, ctx) => getCioDesignReadiness({
        resourceType: input.resource_type,
        resourceId: input.resource_id,
        checkLinks: input.check_links ?? true,
        correlationId: ctx.correlationId,
      }),
    },
  ];

  for (const definition of readDefinitions) registerAdminRead(server, callerHash, definition);

  const writeDefinitions: Array<AdminWriteDefinition<ZodRawShape>> = [
    {
      name: 'cio_admin_write_frequency_cap_create',
      title: 'Create Customer.io frequency cap',
      description: 'Create a schema-backed workspace frequency cap.',
      method: 'POST', destructive: false, idempotent: false,
      inputShape: { name: z.string().min(1).max(200), rules: z.array(frequencyRuleShape).min(1).max(50) },
      path: () => environmentPath('/frequency_caps'),
      body: (input) => ({ frequency_cap: { name: input.name, rules: input.rules } }),
    },
    {
      name: 'cio_admin_write_frequency_cap_update',
      title: 'Update Customer.io frequency cap',
      description: 'Update one schema-backed workspace frequency cap.',
      method: 'PUT', destructive: true, idempotent: true,
      inputShape: { frequency_cap_id: z.number().int().positive(), name: z.string().min(1).max(200), rules: z.array(frequencyRuleShape).min(1).max(50) },
      path: (input) => environmentPath(`/frequency_caps/${input.frequency_cap_id}`),
      body: (input) => ({ frequency_cap: { name: input.name, rules: input.rules } }),
    },
    {
      name: 'cio_admin_write_frequency_cap_delete',
      title: 'Delete Customer.io frequency cap',
      description: 'Delete one frequency cap by ID.',
      method: 'DELETE', destructive: true, idempotent: false,
      inputShape: { frequency_cap_id: z.number().int().positive() },
      path: (input) => environmentPath(`/frequency_caps/${input.frequency_cap_id}`),
    },
    {
      name: 'cio_admin_write_message_limits_update',
      title: 'Update Customer.io workspace message limits',
      description: 'Update workspace message limits using the exact count/window/retry-window schema.',
      method: 'PUT', destructive: true, idempotent: true,
      inputShape: {
        count: z.number().int().min(0),
        retry_window_secs: z.number().int().min(0),
        window_secs: z.number().int().min(1),
      },
      path: () => environmentPath('/message_limits'),
      body: (input) => ({ message_limit: { count: input.count, retry_window_secs: input.retry_window_secs, window_secs: input.window_secs } }),
    },
    {
      name: 'cio_admin_write_preserve_unsubscribes_on_merge',
      title: 'Update Customer.io merge unsubscribe policy',
      description: 'Enable or disable preserve-unsubscribes-on-merge.',
      method: 'POST', destructive: true, idempotent: true,
      inputShape: { enabled: z.boolean() },
      path: () => environmentPath('/preserve_unsubscribes_on_merge'),
      body: (input) => ({ enabled: input.enabled }),
    },
    {
      name: 'cio_admin_write_goal_create',
      title: 'Create Customer.io Goal',
      description: 'Create a Goal using the current full Goal request schema.',
      method: 'POST', destructive: false, idempotent: false,
      inputShape: { goal: goalShape },
      path: () => environmentPath('/goals'),
      body: (input) => ({ goal: input.goal }),
    },
    {
      name: 'cio_admin_write_goal_update',
      title: 'Update Customer.io Goal',
      description: 'Update one Goal using the current full Goal request schema.',
      method: 'PUT', destructive: true, idempotent: true,
      inputShape: { goal_id: z.number().int().positive(), goal: goalShape },
      path: (input) => environmentPath(`/goals/${input.goal_id}`),
      body: (input) => ({ goal: input.goal }),
    },
    {
      name: 'cio_admin_write_goal_delete',
      title: 'Delete Customer.io Goal',
      description: 'Delete one Goal by ID.',
      method: 'DELETE', destructive: true, idempotent: false,
      inputShape: { goal_id: z.number().int().positive() },
      path: (input) => environmentPath(`/goals/${input.goal_id}`),
    },
    {
      name: 'cio_admin_write_subscription_center_settings',
      title: 'Update Customer.io subscription center settings',
      description: 'Update subscription-center colors and logo metadata.',
      method: 'PUT', destructive: true, idempotent: true,
      inputShape: {
        background_color: z.string().min(1).max(64),
        foreground_color: z.string().min(1).max(64),
        logo_path: z.string().max(2000),
        logo_source: z.string().max(128),
      },
      path: () => environmentPath('/subscription_center_settings'),
      body: (input) => ({ background_color: input.background_color, foreground_color: input.foreground_color, logo_path: input.logo_path, logo_source: input.logo_source }),
    },
    {
      name: 'cio_admin_write_subscription_topic_create',
      title: 'Create Customer.io subscription topic',
      description: 'Create a subscription topic using the current schema.',
      method: 'POST', destructive: false, idempotent: false,
      inputShape: { subscription_topic: subscriptionTopicShape },
      path: () => environmentPath('/subscription_topics'),
      body: (input) => ({ subscription_topic: input.subscription_topic }),
    },
    {
      name: 'cio_admin_write_subscription_topic_update',
      title: 'Update Customer.io subscription topic',
      description: 'Update one subscription topic using the current schema.',
      method: 'PUT', destructive: true, idempotent: true,
      inputShape: { topic_id: z.number().int().positive(), subscription_topic: subscriptionTopicShape },
      path: (input) => environmentPath(`/subscription_topics/${input.topic_id}`),
      body: (input) => ({ subscription_topic: input.subscription_topic }),
    },
    {
      name: 'cio_admin_write_subscription_topic_delete',
      title: 'Delete Customer.io subscription topic',
      description: 'Delete one subscription topic by ID.',
      method: 'DELETE', destructive: true, idempotent: false,
      inputShape: { topic_id: z.number().int().positive() },
      path: (input) => environmentPath(`/subscription_topics/${input.topic_id}`),
    },
    {
      name: 'cio_admin_write_subscription_channel_upsert',
      title: 'Upsert Customer.io subscription channel',
      description: 'Create or update a subscription channel using the current schema.',
      method: 'PUT', destructive: true, idempotent: true,
      inputShape: {
        channel_type: z.enum(CHANNEL_TYPES),
        name: z.string().min(1).max(200),
        description: z.string().max(2000),
        opt_in: z.boolean().nullable().optional(),
      },
      path: (input) => environmentPath(`/subscription_channels/${input.channel_type}`),
      body: (input) => ({ subscription_channel: { name: input.name, description: input.description, opt_in: input.opt_in } }),
    },
    {
      name: 'cio_admin_write_subscription_channel_delete',
      title: 'Delete Customer.io subscription channel',
      description: 'Delete one subscription channel by type.',
      method: 'DELETE', destructive: true, idempotent: false,
      inputShape: { channel_type: z.enum(CHANNEL_TYPES) },
      path: (input) => environmentPath(`/subscription_channels/${input.channel_type}`),
    },
    {
      name: 'cio_admin_write_subscription_languages_create',
      title: 'Create Customer.io subscription languages',
      description: 'Create one or more subscription-language slots using the current schema.',
      method: 'POST', destructive: false, idempotent: false,
      inputShape: {
        subscription_languages: z.array(z.object({ id: z.string().min(1).max(32), enabled: z.boolean() }).strict()).min(1).max(50),
      },
      path: () => environmentPath('/subscription_languages'),
      body: (input) => ({ subscription_languages: input.subscription_languages }),
    },
    {
      name: 'cio_admin_write_subscription_language_update',
      title: 'Update Customer.io subscription language',
      description: 'Update one subscription language with its localized topics/channels.',
      method: 'PUT', destructive: true, idempotent: true,
      inputShape: { language_id: z.string().min(1).max(32), subscription_language: subscriptionLanguageShape },
      path: (input) => environmentPath(`/subscription_languages/${encodeURIComponent(String(input.language_id))}`),
      body: (input) => ({ subscription_language: input.subscription_language }),
    },
    {
      name: 'cio_admin_write_subscription_language_delete',
      title: 'Delete Customer.io subscription language',
      description: 'Delete one subscription language by ID.',
      method: 'DELETE', destructive: true, idempotent: false,
      inputShape: { language_id: z.string().min(1).max(32) },
      path: (input) => environmentPath(`/subscription_languages/${encodeURIComponent(String(input.language_id))}`),
    },
    {
      name: 'cio_admin_write_subscription_page_create',
      title: 'Create Customer.io subscription page',
      description: 'Create a subscription page with the current ID/header schema.',
      method: 'POST', destructive: false, idempotent: false,
      inputShape: {
        page_id: z.string().min(1).max(128),
        title: z.string().max(500),
        subtitle: z.string().max(2000),
      },
      path: () => environmentPath('/subscription_pages'),
      body: (input) => ({ subscription_page: { id: input.page_id, header: { title: input.title, subtitle: input.subtitle } } }),
    },
    {
      name: 'cio_admin_write_subscription_page_update',
      title: 'Update Customer.io subscription page',
      description: 'Update one subscription page with the current ID/header schema.',
      method: 'PUT', destructive: true, idempotent: true,
      inputShape: {
        subscription_page_id: z.string().min(1).max(128),
        page_id: z.string().min(1).max(128),
        title: z.string().max(500),
        subtitle: z.string().max(2000),
      },
      path: (input) => environmentPath(`/subscription_pages/${encodeURIComponent(String(input.subscription_page_id))}`),
      body: (input) => ({ subscription_page: { id: input.page_id, header: { title: input.title, subtitle: input.subtitle } } }),
    },
    {
      name: 'cio_admin_write_subscription_topic_order',
      title: 'Update Customer.io subscription topic order',
      description: 'Save the ordered subscription-topic ID list.',
      method: 'PUT', destructive: true, idempotent: true,
      inputShape: { topic_order: z.array(z.number().int().positive()).max(500) },
      path: () => environmentPath('/subscription_topic_order'),
      body: (input) => ({ topic_order: input.topic_order }),
    },
    {
      name: 'cio_admin_write_subscription_channel_order',
      title: 'Update Customer.io subscription channel order',
      description: 'Save the ordered subscription-channel ID list.',
      method: 'PUT', destructive: true, idempotent: true,
      inputShape: { channel_order: z.array(z.number().int().positive()).max(50) },
      path: () => environmentPath('/subscription_channel_order'),
      body: (input) => ({ channel_order: input.channel_order }),
    },
    {
      name: 'cio_admin_write_open_tracking_consent',
      title: 'Update Customer.io open-tracking consent policy',
      description: 'Update the workspace open-tracking/consent fields. This setting requires an owner/legal approval reference and a read-merge-write against current workspace state.',
      method: 'PUT', destructive: true, idempotent: true,
      inputShape: {
        email_open_tracking: z.boolean().optional(),
        honor_open_tracking_consent: z.boolean().optional(),
        open_tracking_consent_mode: z.string().min(1).max(32).optional(),
      },
      path: () => environmentPath(),
      body: (input) => ({
        email_open_tracking: input.email_open_tracking,
        honor_open_tracking_consent: input.honor_open_tracking_consent,
        open_tracking_consent_mode: input.open_tracking_consent_mode,
      }),
      execute: async (input, ctx) => {
        const patch: Record<string, unknown> = {};
        for (const key of ['email_open_tracking', 'honor_open_tracking_consent', 'open_tracking_consent_mode']) {
          if (input[key] !== undefined) patch[key] = input[key];
        }
        if (Object.keys(patch).length === 0) throw new Error('At least one open-tracking consent field is required.');
        const current = await flyGet(environmentPath(), { correlationId: ctx.correlationId });
        return flyWrite('PUT', environmentPath(), environmentUpdateBody(current, patch), { correlationId: ctx.correlationId });
      },
    },
  ];

  for (const definition of writeDefinitions) registerAdminWrite(server, callerHash, definition);

  if (readDefinitions.length !== CIO_ADMIN_READ_TOOLS.length || writeDefinitions.length !== CIO_ADMIN_WRITE_TOOLS.length) {
    throw new Error('Customer.io admin tool registry is out of sync with the fixed public tool lists.');
  }
}

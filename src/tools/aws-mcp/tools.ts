/**
 * CTO-lane bridge to the AWS MCP Server (https://aws-mcp.us-east-1.api.aws/mcp).
 *
 * Why this exists: Claude reaches AWS through the claude.ai "AWS MCP" connector, whose OAuth session
 * lasts at most 12 hours and was historically signed in as the account root user. This bridge gives
 * the CTO lane durable, read-only AWS access through the gateway instead: the gateway assumes a
 * dedicated read-only IAM role with STS (credentials.ts) and calls the AWS MCP Server server-side
 * with SigV4 (signed-fetch.ts, upstream.ts).
 *
 * Two tools:
 *   aws_mcp_tool_list  list the upstream tools and their input schemas
 *   aws_mcp_tool_call  call one allowlisted upstream tool by name
 *
 * READ-ONLY IS ENFORCED BY THE IDENTITY. The reader role is ViewOnlyAccess plus explicit denies on
 * secret and data-content reads, so even `aws___run_script` (Python in an AWS-hosted sandbox) can
 * only read metadata. The bridge adds an upstream-tool allowlist on top, and blocks
 * `aws___get_presigned_url` outright so the bridge never mints data upload or download links.
 *
 * WHO MAY CALL (see access.ts): the CTO lane over an OAuth-issued session only: a token the gateway's
 * OAuth endpoints issued through the authorization_code grant (the claude.ai connector flow), or through
 * the refresh_token grant that renews it. Static credentials that resolve to the CTO lane (the connector
 * token, the M365 and Codex tokens) are refused, whatever lane they carry. So is an OAuth token from the
 * client_credentials grant (a machine credential). That shows how the token was issued, not that a
 * person is present; access.ts says what it leaves open. Three independent layers, all CTO only:
 *   1. connector visibility: registry.ts connectorToolset advertises these names to the cto lane only
 *      (lane-toolsets.ts keeps them in the cto curated list so real CTO sessions still see them);
 *   2. execution governance: catalog/governance.ts `aws_mcp_*` requires the cto role;
 *   3. in-handler check: every core function below refuses any other caller, and any request that
 *      did not authenticate with an OAuth-issued session, before touching AWS. The kill switch
 *      AWS_MCP_BRIDGE_DISABLED is checked in the same place.
 *
 * FAIL CLOSED. If the reader role cannot be assumed, the call fails with a clear message and no
 * request is sent to the AWS MCP Server. There is no fallback to any other credentials.
 *
 * Output is untrusted external data: capped, control characters stripped, credential-shaped strings
 * redacted, and labelled (see output.ts). It is returned inline and never offloaded to the shared
 * result cache (result-store.ts mayOffloadToolResult). Every call writes one audit line (audit.ts)
 * with hashes and sizes only. Nothing here logs credentials, signatures, tokens or script text. The
 * registry's tool-start log records only a count of input fields, and redactInputForLog keeps
 * argument values (a pasted script can carry anything) out of any other record of the call.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { currentAuthGrant, currentAuthKind, currentAuthSubject, type AuthKind, type OAuthGrantType } from '../../server/request-context.js';
import { registerTool, type CallerHashProvider, type ToolContext } from '../registry.js';
import { AwsMcpRefusalError, assertBridgeAccess } from './access.js';
import { BridgeCallAudit, sha256Hex } from './audit.js';
import {
  AWS_AI_READER_ROLE_NAME,
  readerCredentials,
} from './credentials.js';
import { AWS_MCP_MAX_OUTPUT_BYTES, AWS_MCP_UNTRUSTED_NOTICE, shapeUpstreamText } from './output.js';
import { AWS_MCP_ENDPOINT, resolveSigningScope } from './signed-fetch.js';
import { callUpstreamTool, listUpstreamTools, type UpstreamDeps } from './upstream.js';

export const AWS_MCP_TOOL_LIST_NAME = 'aws_mcp_tool_list';
export const AWS_MCP_TOOL_CALL_NAME = 'aws_mcp_tool_call';
export const AWS_MCP_TOOL_NAMES: readonly string[] = [AWS_MCP_TOOL_LIST_NAME, AWS_MCP_TOOL_CALL_NAME];
/** Hard backstop for the complete inline response; the output budget keeps real responses far below it. */
const AWS_MCP_MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_ARGUMENTS_JSON_BYTES = 100_000;
/** Budget for the pretty-printed tools array of aws_mcp_tool_list. */
const AWS_MCP_LIST_DATA_BUDGET_BYTES = 26_000;
const AWS_MCP_LIST_MAX_ENTRIES = 200;
const MAX_TOOL_DESCRIPTION_BYTES = 1_500;

const RUN_SCRIPT_UPSTREAM_TOOL = 'aws___run_script';

/** Upstream tools the bridge will call. Anything else is refused until it is reviewed and added here. */
export const AWS_MCP_ALLOWED_UPSTREAM_TOOLS: readonly string[] = [
  RUN_SCRIPT_UPSTREAM_TOOL,
  'aws___search_documentation',
  'aws___read_documentation',
  'aws___retrieve_skill',
  'aws___list_regions',
  'aws___get_regional_availability',
  'aws___get_tasks',
];

/** Upstream tools the bridge refuses by name, with the reason shown to the caller. */
const BLOCKED_UPSTREAM_TOOLS: ReadonlyMap<string, string> = new Map([
  [
    'aws___get_presigned_url',
    'it mints pre-signed S3 upload and download links, and this bridge never hands out data transfer links',
  ],
]);

export type BridgeStatus = 'allowed' | 'blocked' | 'not_allowlisted';

export function bridgeStatusOf(upstreamName: string): BridgeStatus {
  if (BLOCKED_UPSTREAM_TOOLS.has(upstreamName)) return 'blocked';
  return AWS_MCP_ALLOWED_UPSTREAM_TOOLS.includes(upstreamName) ? 'allowed' : 'not_allowlisted';
}

export const AWS_MCP_TOOL_LIST_INPUT_SHAPE = {};
export const AWS_MCP_TOOL_CALL_INPUT_SHAPE = {
  tool_name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .describe(
      `Upstream AWS MCP tool name, for example aws___search_documentation. Allowed: ${AWS_MCP_ALLOWED_UPSTREAM_TOOLS.join(', ')}. ` +
        'Call aws_mcp_tool_list for each tool\'s description and input schema.',
    ),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Arguments object for the upstream tool, exactly as its input schema describes. At most about 100 KB of JSON.'),
  region: z
    .string()
    .max(32)
    .regex(/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/)
    .optional()
    .describe('Default AWS region for the upstream call, for example us-east-2. Defaults to us-east-1.'),
};

const toolCallInputSchema = z.object(AWS_MCP_TOOL_CALL_INPUT_SHAPE).strict();
const toolListInputSchema = z.object(AWS_MCP_TOOL_LIST_INPUT_SHAPE).strict();

/** What the bridge needs to know about one call: who called, how they authenticated, and the correlation id. */
export type AwsMcpToolContext = Pick<ToolContext, 'callerAgent' | 'correlationId' | 'callerHash'> & {
  /** How the request authenticated (request context authKind); only 'oauth' is served. */
  authKind?: AuthKind;
  /** For an OAuth request, the grant that issued its token (request context authGrant); only authorization_code and refresh_token are served. */
  authGrant?: OAuthGrantType;
  /** For an OAuth request, the client id the token was issued to (request context authSubject); recorded in the audit line only. */
  authSubject?: string;
};

/** Test seam: everything that touches the network or the clock can be replaced. */
export type AwsMcpDeps = Partial<UpstreamDeps>;

function resolveDeps(deps: AwsMcpDeps | undefined): UpstreamDeps {
  return {
    getCredentials: (sessionHint) => readerCredentials.get(sessionHint),
    ...deps,
  };
}

function auditFor(tool: typeof AWS_MCP_TOOL_LIST_NAME | typeof AWS_MCP_TOOL_CALL_NAME, ctx: AwsMcpToolContext): BridgeCallAudit {
  return new BridgeCallAudit({
    bridgeTool: tool,
    correlationId: ctx.correlationId,
    callerHash: ctx.callerHash,
    authKind: ctx.authKind,
    authGrant: ctx.authGrant,
    authSubject: ctx.authSubject,
  });
}

/** Reported when the credential provider did not say which role it assumed (test doubles only). */
const ROLE_NOT_REPORTED = 'unknown';

export interface AwsMcpToolListEntry {
  name: string;
  bridge_status: BridgeStatus;
  description?: string;
  input_schema?: unknown;
  /** True when detail was dropped to stay inside the output budget. */
  detail_omitted?: true;
}

export interface AwsMcpToolListResult {
  tools: AwsMcpToolListEntry[];
  /** How many tools the AWS MCP Server advertises. */
  tool_count: number;
  /** Tools advertised but not listed at all (entry cap or output budget): tools.length + omitted_tools = tool_count. */
  omitted_tools: number;
  truncated: boolean;
  /** reader_role_arn is the role that was actually assumed for this call. */
  bridge: { endpoint_host: string; signing_service: string; signing_region: string; reader_role_arn: string };
  notice: string;
}

/** List the tools the AWS MCP Server advertises, each marked allowed, blocked or not allowlisted. */
export async function listAwsMcpTools(
  rawInput: unknown,
  ctx: AwsMcpToolContext,
  deps?: AwsMcpDeps,
): Promise<AwsMcpToolListResult> {
  const audit = auditFor(AWS_MCP_TOOL_LIST_NAME, ctx);
  try {
    const result = await listAwsMcpToolsChecked(rawInput, ctx, audit, deps);
    return result;
  } catch (err) {
    audit.failure(err);
    throw err;
  }
}

async function listAwsMcpToolsChecked(
  rawInput: unknown,
  ctx: AwsMcpToolContext,
  audit: BridgeCallAudit,
  deps?: AwsMcpDeps,
): Promise<AwsMcpToolListResult> {
  assertBridgeAccess(ctx);
  if (!toolListInputSchema.safeParse(rawInput ?? {}).success) {
    throw new AwsMcpRefusalError('aws_mcp_invalid_input', 'aws_mcp_tool_list takes no arguments.');
  }
  const resolved = resolveDeps(deps);
  const scope = resolved.scope ?? resolveSigningScope();
  const { tools: upstream, identity } = await listUpstreamTools({ ...resolved, scope }, ctx.correlationId);

  // Measured on the pretty-printed form the gateway renders, so the whole response stays under the
  // size at which the registry would offload a result into the shared cache.
  const fits = (entries: AwsMcpToolListEntry[]): boolean =>
    Buffer.byteLength(JSON.stringify({ tools: entries }, null, 2), 'utf8') <= AWS_MCP_LIST_DATA_BUDGET_BYTES;

  let descriptionsTruncated = false;
  const candidates = upstream.slice(0, AWS_MCP_LIST_MAX_ENTRIES).map((tool) => {
    const name = shapeUpstreamText(tool.name, 100).text;
    const bridgeStatus = bridgeStatusOf(tool.name);
    const shapedDescription = tool.description === undefined ? undefined : shapeUpstreamText(tool.description, MAX_TOOL_DESCRIPTION_BYTES);
    if (shapedDescription?.truncated) descriptionsTruncated = true;
    const stub: AwsMcpToolListEntry = { name, bridge_status: bridgeStatus, detail_omitted: true };
    const full: AwsMcpToolListEntry = {
      name,
      bridge_status: bridgeStatus,
      ...(shapedDescription === undefined ? {} : { description: shapedDescription.text }),
      ...(tool.inputSchema === undefined ? {} : { input_schema: tool.inputSchema }),
    };
    return { stub, full };
  });

  // Discoverability first: list as many names as fit, then upgrade entries to full detail in order
  // while the whole list still fits the budget.
  let tools: AwsMcpToolListEntry[] = [];
  for (const candidate of candidates) {
    if (!fits([...tools, candidate.stub])) break;
    tools.push(candidate.stub);
  }
  for (let i = 0; i < tools.length; i += 1) {
    const upgraded = tools.slice();
    upgraded[i] = candidates[i].full;
    if (fits(upgraded)) tools = upgraded;
  }
  const omittedTools = upstream.length - tools.length;
  const truncated = omittedTools > 0 || descriptionsTruncated || tools.some((t) => t.detail_omitted);

  audit.success({
    responseBytes: Buffer.byteLength(JSON.stringify(upstream), 'utf8'),
    isError: false,
    roleSessionName: identity?.roleSessionName,
  });
  return {
    tools,
    tool_count: upstream.length,
    omitted_tools: omittedTools,
    truncated,
    bridge: {
      endpoint_host: new URL(AWS_MCP_ENDPOINT).host,
      signing_service: scope.service,
      signing_region: scope.region,
      reader_role_arn: identity?.roleArn ?? ROLE_NOT_REPORTED,
    },
    notice: AWS_MCP_UNTRUSTED_NOTICE,
  };
}

export interface AwsMcpToolCallResult {
  upstream_tool: string;
  region: string;
  /** The reader role that was actually assumed for this call. */
  reader_role_arn: string;
  /** True when the upstream tool itself reported an error (the text then says why). */
  is_error: boolean;
  content_text: string;
  truncated: boolean;
  /** UTF-8 bytes of the upstream text as received, before stripping, redaction or truncation. */
  original_bytes: number;
  redactions: number;
  omitted_non_text_blocks: number;
  notice: string;
}

/** Call one allowlisted upstream AWS MCP tool. */
export async function callAwsMcpTool(
  rawInput: unknown,
  ctx: AwsMcpToolContext,
  deps?: AwsMcpDeps,
): Promise<AwsMcpToolCallResult> {
  const audit = auditFor(AWS_MCP_TOOL_CALL_NAME, ctx);
  try {
    return await callAwsMcpToolChecked(rawInput, ctx, audit, deps);
  } catch (err) {
    audit.failure(err);
    throw err;
  }
}

async function callAwsMcpToolChecked(
  rawInput: unknown,
  ctx: AwsMcpToolContext,
  audit: BridgeCallAudit,
  deps?: AwsMcpDeps,
): Promise<AwsMcpToolCallResult> {
  assertBridgeAccess(ctx);

  const parsed = toolCallInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AwsMcpRefusalError('aws_mcp_invalid_input', 'expected { tool_name, arguments?, region? } with a valid tool_name and region.');
  }
  const { tool_name: toolName, arguments: args = {}, region = 'us-east-1' } = parsed.data;
  // Only values that passed the schema above are noted for the audit line.
  audit.note({ upstreamTool: toolName, region });

  const blockedReason = BLOCKED_UPSTREAM_TOOLS.get(toolName);
  if (blockedReason) {
    throw new AwsMcpRefusalError('aws_mcp_tool_blocked', `${toolName} is blocked by the bridge because ${blockedReason}.`);
  }
  if (!AWS_MCP_ALLOWED_UPSTREAM_TOOLS.includes(toolName)) {
    throw new AwsMcpRefusalError(
      'aws_mcp_tool_not_allowed',
      `${toolName} is not on the bridge allowlist. Allowed: ${AWS_MCP_ALLOWED_UPSTREAM_TOOLS.join(', ')}.`,
    );
  }
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENTS_JSON_BYTES) {
    throw new AwsMcpRefusalError('aws_mcp_invalid_input', 'arguments exceed the 100 KB limit.');
  }
  // A script is never logged, only its SHA-256, so a run can be matched to a pasted script later.
  if (toolName === RUN_SCRIPT_UPSTREAM_TOOL && typeof args.script === 'string') {
    audit.note({ scriptSha256: sha256Hex(args.script) });
  }

  const upstream = await callUpstreamTool(resolveDeps(deps), ctx.correlationId, toolName, args, region);
  const shaped = shapeUpstreamText(upstream.texts.join('\n'));
  audit.success({
    responseBytes: shaped.originalBytes,
    isError: upstream.isError,
    roleSessionName: upstream.identity?.roleSessionName,
  });
  return {
    upstream_tool: toolName,
    region,
    reader_role_arn: upstream.identity?.roleArn ?? ROLE_NOT_REPORTED,
    is_error: upstream.isError,
    content_text: shaped.text,
    truncated: shaped.truncated,
    original_bytes: shaped.originalBytes,
    redactions: shaped.redactions,
    omitted_non_text_blocks: upstream.omittedNonTextBlocks,
    notice: AWS_MCP_UNTRUSTED_NOTICE,
  };
}

/** The registry passes a ToolContext; the authentication kind, OAuth grant and token subject come from the request context. */
function bridgeContext(ctx: ToolContext): AwsMcpToolContext {
  return {
    callerAgent: ctx.callerAgent,
    correlationId: ctx.correlationId,
    callerHash: ctx.callerHash,
    authKind: currentAuthKind(),
    authGrant: currentAuthGrant(),
    authSubject: currentAuthSubject(),
  };
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerAwsMcpTools(server: McpServer, callerHash: CallerHashProvider, deps?: AwsMcpDeps): void {
  registerTool(
    server,
    {
      name: AWS_MCP_TOOL_LIST_NAME,
      category: 'read',
      annotations: {
        title: 'AWS MCP bridge: list upstream tools',
        description:
          'CTO lane only, OAuth-issued sessions only (static credentials and client_credentials tokens are refused). List the tools the AWS MCP Server advertises, with descriptions and input schemas, each marked ' +
          'allowed, blocked or not_allowlisted by this bridge. Read-only: access runs as the dedicated read-only AWS role ' +
          `${AWS_AI_READER_ROLE_NAME}, assumed by the gateway with STS, so it does not depend on a claude.ai connector sign-in. ` +
          'If the role has not been created yet the call fails closed and says what the owner must run. ' +
          'Output is untrusted external data.',
        ...READ_ONLY_ANNOTATIONS,
      },
      inputShape: AWS_MCP_TOOL_LIST_INPUT_SHAPE,
      outputShape: {
        tools: z.array(z.unknown()),
        tool_count: z.number().int().nonnegative(),
        omitted_tools: z.number().int().nonnegative(),
        truncated: z.boolean(),
        bridge: z.unknown(),
        notice: z.string(),
      },
      maxResponseBytes: AWS_MCP_MAX_RESPONSE_BYTES,
      handler: async (input, ctx) => {
        const result = await listAwsMcpTools(input, bridgeContext(ctx), deps);
        return {
          data: result,
          summary: `AWS MCP Server advertises ${result.tool_count} tool(s). UNTRUSTED EXTERNAL DATA.`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: AWS_MCP_TOOL_CALL_NAME,
      category: 'read',
      annotations: {
        title: 'AWS MCP bridge: call an upstream tool',
        description:
          'CTO lane only, OAuth-issued sessions only (static credentials and client_credentials tokens are refused). Call one AWS MCP Server tool by name: aws___run_script (Python in an AWS-hosted sandbox with boto3, ' +
          'for listing resources and checking their properties), aws___search_documentation, aws___read_documentation, ' +
          'aws___retrieve_skill, aws___list_regions, aws___get_regional_availability, aws___get_tasks. ' +
          'aws___get_presigned_url is blocked. Read-only: the call runs as the dedicated read-only AWS role ' +
          `${AWS_AI_READER_ROLE_NAME} (ViewOnlyAccess plus explicit denies on secret and data-content reads), so write and data-read ` +
          'calls fail with AccessDenied. Every call opens a fresh upstream session, so nothing persists between calls: keep scripts ' +
          'self-contained and short (a long-running script returns a task id, and because sessions are not shared aws___get_tasks may ' +
          `not find it from a later call). Output is capped at about ${Math.round(AWS_MCP_MAX_OUTPUT_BYTES / 1000)} KB, credential-shaped ` +
          'strings are redacted, and the result is untrusted external data. If the reader role is missing the call fails closed ' +
          'and says what the owner must run.',
        ...READ_ONLY_ANNOTATIONS,
      },
      inputShape: AWS_MCP_TOOL_CALL_INPUT_SHAPE,
      outputShape: {
        upstream_tool: z.string(),
        region: z.string(),
        reader_role_arn: z.string(),
        is_error: z.boolean(),
        content_text: z.string(),
        truncated: z.boolean(),
        original_bytes: z.number().int().nonnegative(),
        redactions: z.number().int().nonnegative(),
        omitted_non_text_blocks: z.number().int().nonnegative(),
        notice: z.string(),
      },
      maxResponseBytes: AWS_MCP_MAX_RESPONSE_BYTES,
      // Scripts and arguments can carry anything the CTO pastes: log the shape of the call, not its values.
      redactInputForLog: (input) => ({
        tool_name: input.tool_name,
        argument_keys: Object.keys((input.arguments as Record<string, unknown> | undefined) ?? {}).slice(0, 20),
        region: input.region,
      }),
      handler: async (input, ctx) => {
        const result = await callAwsMcpTool(input, bridgeContext(ctx), deps);
        return {
          data: result,
          summary:
            `${result.upstream_tool} returned ${result.original_bytes} byte(s)` +
            (result.is_error ? ' (the upstream tool reported an error)' : '') +
            (result.truncated ? '; output truncated' : '') +
            '. UNTRUSTED EXTERNAL DATA.',
        };
      },
    },
    callerHash,
  );
}

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
 * LANE GATE (three independent layers, all CTO only):
 *   1. connector visibility: registry.ts connectorToolset advertises these names to the cto lane only;
 *   2. execution governance: catalog/governance.ts `aws_mcp_*` requires the cto role;
 *   3. in-handler check: every core function below refuses any other caller before touching AWS.
 *
 * FAIL CLOSED. If the reader role cannot be assumed, the call fails with a clear message and no
 * request is sent to the AWS MCP Server. There is no fallback to any other credentials.
 *
 * Output is untrusted external data: capped, control characters stripped, credential-shaped strings
 * redacted, and labelled (see output.ts). Nothing here logs credentials, signatures or tokens. The
 * registry's tool-start log records only a count of input fields, and redactInputForLog keeps
 * argument values (a pasted script can carry anything) out of any other record of the call.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext } from '../registry.js';
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

/** Upstream tools the bridge will call. Anything else is refused until it is reviewed and added here. */
export const AWS_MCP_ALLOWED_UPSTREAM_TOOLS: readonly string[] = [
  'aws___run_script',
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

export type AwsMcpToolContext = Pick<ToolContext, 'callerAgent' | 'correlationId'>;

/** Test seam: everything that touches the network or the clock can be replaced. */
export type AwsMcpDeps = Partial<UpstreamDeps>;

function resolveDeps(deps: AwsMcpDeps | undefined): UpstreamDeps {
  return {
    getCredentials: (sessionHint) => readerCredentials.get(sessionHint),
    ...deps,
  };
}

function assertCtoLane(ctx: AwsMcpToolContext): void {
  if (ctx.callerAgent !== 'cto') {
    throw new Error('aws_mcp_forbidden: the AWS bridge is available to the CTO lane only.');
  }
}

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
  bridge: { endpoint_host: string; signing_service: string; signing_region: string; reader_role_name: string };
  notice: string;
}

/** List the tools the AWS MCP Server advertises, each marked allowed, blocked or not allowlisted. */
export async function listAwsMcpTools(
  rawInput: unknown,
  ctx: AwsMcpToolContext,
  deps?: AwsMcpDeps,
): Promise<AwsMcpToolListResult> {
  assertCtoLane(ctx);
  if (!toolListInputSchema.safeParse(rawInput ?? {}).success) {
    throw new Error('aws_mcp_invalid_input: aws_mcp_tool_list takes no arguments.');
  }
  const resolved = resolveDeps(deps);
  const scope = resolved.scope ?? resolveSigningScope();
  const upstream = await listUpstreamTools({ ...resolved, scope }, ctx.correlationId);

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

  return {
    tools,
    tool_count: upstream.length,
    omitted_tools: omittedTools,
    truncated,
    bridge: {
      endpoint_host: new URL(AWS_MCP_ENDPOINT).host,
      signing_service: scope.service,
      signing_region: scope.region,
      reader_role_name: AWS_AI_READER_ROLE_NAME,
    },
    notice: AWS_MCP_UNTRUSTED_NOTICE,
  };
}

export interface AwsMcpToolCallResult {
  upstream_tool: string;
  region: string;
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
  assertCtoLane(ctx);

  const parsed = toolCallInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new Error('aws_mcp_invalid_input: expected { tool_name, arguments?, region? } with a valid tool_name and region.');
  }
  const { tool_name: toolName, arguments: args = {}, region = 'us-east-1' } = parsed.data;

  const blockedReason = BLOCKED_UPSTREAM_TOOLS.get(toolName);
  if (blockedReason) {
    throw new Error(`aws_mcp_tool_blocked: ${toolName} is blocked by the bridge because ${blockedReason}.`);
  }
  if (!AWS_MCP_ALLOWED_UPSTREAM_TOOLS.includes(toolName)) {
    throw new Error(
      `aws_mcp_tool_not_allowed: ${toolName} is not on the bridge allowlist. Allowed: ${AWS_MCP_ALLOWED_UPSTREAM_TOOLS.join(', ')}.`,
    );
  }
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENTS_JSON_BYTES) {
    throw new Error('aws_mcp_invalid_input: arguments exceed the 100 KB limit.');
  }

  const upstream = await callUpstreamTool(resolveDeps(deps), ctx.correlationId, toolName, args, region);
  const shaped = shapeUpstreamText(upstream.texts.join('\n'));
  return {
    upstream_tool: toolName,
    region,
    is_error: upstream.isError,
    content_text: shaped.text,
    truncated: shaped.truncated,
    original_bytes: shaped.originalBytes,
    redactions: shaped.redactions,
    omitted_non_text_blocks: upstream.omittedNonTextBlocks,
    notice: AWS_MCP_UNTRUSTED_NOTICE,
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
          'CTO lane only. List the tools the AWS MCP Server advertises, with descriptions and input schemas, each marked ' +
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
        const result = await listAwsMcpTools(input, ctx, deps);
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
          'CTO lane only. Call one AWS MCP Server tool by name: aws___run_script (Python in an AWS-hosted sandbox with boto3, ' +
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
        const result = await callAwsMcpTool(input, ctx, deps);
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

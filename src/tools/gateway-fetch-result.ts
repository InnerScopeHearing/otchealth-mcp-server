/**
 * gateway_fetch_result retrieves a caller-bound JIT-offloaded tool result by id.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  registerTool,
  type CallerHashProvider,
  type ToolContext,
  type ToolResultPayload,
} from './registry.js';
import { fetchStoredResult, type FetchOutcome, type ResultCursor } from './result-store.js';

export interface GatewayFetchResultInput {
  result_id: string;
  page?: number;
  offset?: number;
  max_chunk_bytes?: number;
  expected_origin_tool?: string;
}

export interface GatewayFetchResultDeps {
  fetchStoredResult: (
    resultId: string,
    page: number,
    callerHash: string,
    cursor?: ResultCursor,
    expectedOriginTool?: string,
  ) => Promise<FetchOutcome>;
}

const DEFAULT_DEPS: GatewayFetchResultDeps = {
  fetchStoredResult: (id, page, callerHash, cursor, expectedOriginTool) =>
    fetchStoredResult(id, page, callerHash, undefined, cursor, expectedOriginTool),
};

export async function handleGatewayFetchResult(
  input: GatewayFetchResultInput,
  ctx: Pick<ToolContext, 'callerHash'>,
  deps: GatewayFetchResultDeps = DEFAULT_DEPS,
): Promise<ToolResultPayload> {
  const cursorMode = input.max_chunk_bytes !== undefined;
  if ((input.page !== undefined && (cursorMode || input.offset !== undefined)) ||
      (input.offset !== undefined && !cursorMode) ||
      (cursorMode && (!Number.isSafeInteger(input.max_chunk_bytes) || input.max_chunk_bytes! < 1024 ||
       input.max_chunk_bytes! > 30000)) ||
      (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0))) {
    throw new Error('Invalid result cursor request');
  }
  const cursor = cursorMode
    ? { offset: input.offset ?? 0, maxChunkBytes: input.max_chunk_bytes! }
    : undefined;
  const r = cursorMode
    ? input.expected_origin_tool === undefined
      ? await deps.fetchStoredResult(input.result_id, 0, ctx.callerHash, cursor)
      : await deps.fetchStoredResult(input.result_id, 0, ctx.callerHash, cursor, input.expected_origin_tool)
    : input.expected_origin_tool === undefined
      ? await deps.fetchStoredResult(input.result_id, input.page ?? 0, ctx.callerHash)
      : await deps.fetchStoredResult(input.result_id, input.page ?? 0, ctx.callerHash, undefined, input.expected_origin_tool);
  // A successful lookup with an expected origin means the authorized stored record matched it.
  // This receipt lets clients distinguish enforced binding from older gateways that ignore unknown
  // input fields. Keep the legacy response shape when callers do not request origin verification.
  const result = r.found && input.expected_origin_tool !== undefined
    ? { ...r, verified_origin_tool: input.expected_origin_tool }
    : r;
  const summary = r.found
    ? cursorMode ? 'result ' + input.result_id + ': cursor chunk (' + String(r.total_bytes) + ' UTF-8 bytes total)'
    : 'result ' + input.result_id + ': page ' + String((r.page ?? 0) + 1) + '/' +
      String(r.pages) + ' (' + String(r.total_bytes) + ' UTF-8 bytes total)'
    : r.expired
      ? 'result ' + input.result_id + ' has expired (offloaded results are short-lived).'
      : 'no stored result for ' + input.result_id + ' (invalid id, unauthorized, or expired).';
  return { data: result, summary };
}

export function registerGatewayFetchResult(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'gateway_fetch_result',
      category: 'read',
      annotations: {
        title: 'Fetch a JIT-offloaded tool result',
        description:
          'Retrieve your caller-bound payload from a large tool result that was offloaded to keep context small. Pass the result_id shown in your truncated response, plus page (0-based) to page through it. Another authenticated caller cannot use the id.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        result_id: z.string().min(1).describe('The result_id from your JIT-offloaded tool response.'),
        expected_origin_tool: z.string().min(1).max(128).optional().describe('Optional verification that the result originated from this exact tool. A mismatch returns the same generic miss as an invalid or unauthorized id.'),
        page: z.number().int().min(0).optional().describe('0-based page for large payloads (default 0).'),
        max_chunk_bytes: z.number().int().min(1024).max(30000).optional().describe('Use cursor mode with this maximum JSON-escaped UTF-8 chunk size; 8192 is recommended. Do not combine with page.'),
        offset: z.number().int().min(0).optional().describe('Opaque cursor from the prior next_offset; omit for the first cursor call. Requires max_chunk_bytes.'),
      },
      outputShape: {
        found: z.boolean(),
        verified_origin_tool: z.string().optional(),
        total_bytes: z.number().optional(),
        page: z.number().optional(),
        pages: z.number().optional(),
        chunk: z.string().optional(),
        expired: z.boolean().optional(),
        offset: z.number().optional(),
        next_offset: z.number().nullable().optional(),
        done: z.boolean().optional(),
      },
      handler: handleGatewayFetchResult,
    },
    callerHash,
  );
}

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
}

export interface GatewayFetchResultDeps {
  fetchStoredResult: (
    resultId: string,
    page: number,
    callerHash: string,
    cursor?: ResultCursor,
  ) => Promise<FetchOutcome>;
}

const DEFAULT_DEPS: GatewayFetchResultDeps = {
  fetchStoredResult: (id, page, callerHash, cursor) =>
    fetchStoredResult(id, page, callerHash, undefined, cursor),
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
  const r = cursorMode
    ? await deps.fetchStoredResult(input.result_id, 0, ctx.callerHash,
        { offset: input.offset ?? 0, maxChunkBytes: input.max_chunk_bytes! })
    : await deps.fetchStoredResult(input.result_id, input.page ?? 0, ctx.callerHash);
  const summary = r.found
    ? cursorMode ? 'result ' + input.result_id + ': cursor chunk (' + String(r.total_bytes) + ' UTF-8 bytes total)'
    : 'result ' + input.result_id + ': page ' + String((r.page ?? 0) + 1) + '/' +
      String(r.pages) + ' (' + String(r.total_bytes) + ' UTF-8 bytes total)'
    : r.expired
      ? 'result ' + input.result_id + ' has expired (offloaded results are short-lived).'
      : 'no stored result for ' + input.result_id + ' (invalid id, unauthorized, or expired).';
  return { data: r, summary };
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
        page: z.number().int().min(0).optional().describe('0-based page for large payloads (default 0).'),
        max_chunk_bytes: z.number().int().min(1024).max(30000).optional().describe('Use cursor mode with this maximum JSON-escaped UTF-8 chunk size; 8192 is recommended. Do not combine with page.'),
        offset: z.number().int().min(0).optional().describe('Opaque cursor from the prior next_offset; omit for the first cursor call. Requires max_chunk_bytes.'),
      },
      outputShape: {
        found: z.boolean(),
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

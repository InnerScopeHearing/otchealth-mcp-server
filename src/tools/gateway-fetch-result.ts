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
import { fetchStoredResult, type FetchOutcome } from './result-store.js';

export interface GatewayFetchResultInput {
  result_id: string;
  page?: number;
}

export interface GatewayFetchResultDeps {
  fetchStoredResult: (
    resultId: string,
    page: number,
    callerHash: string,
  ) => Promise<FetchOutcome>;
}

const DEFAULT_DEPS: GatewayFetchResultDeps = { fetchStoredResult };

export async function handleGatewayFetchResult(
  input: GatewayFetchResultInput,
  ctx: Pick<ToolContext, 'callerHash'>,
  deps: GatewayFetchResultDeps = DEFAULT_DEPS,
): Promise<ToolResultPayload> {
  const r = await deps.fetchStoredResult(input.result_id, input.page ?? 0, ctx.callerHash);
  const summary = r.found
    ? 'result ' + input.result_id + ': page ' + String((r.page ?? 0) + 1) + '/' +
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
      },
      outputShape: {
        found: z.boolean(),
        total_bytes: z.number().optional(),
        page: z.number().optional(),
        pages: z.number().optional(),
        chunk: z.string().optional(),
        expired: z.boolean().optional(),
      },
      handler: handleGatewayFetchResult,
    },
    callerHash,
  );
}

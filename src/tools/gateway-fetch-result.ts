/**
 * gateway_fetch_result — retrieve a JIT-offloaded tool result by id.
 *
 * When a tool result is too large it is offloaded (see result-store.ts) and the inline response is
 * replaced with a preview + result_id. This read tool pulls the full payload back on demand, paged
 * so even very large payloads can be walked without blowing the context in one shot.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from './registry.js';
import { fetchStoredResult } from './result-store.js';

export function registerGatewayFetchResult(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'gateway_fetch_result',
      category: 'read',
      annotations: {
        title: 'Fetch a JIT-offloaded tool result',
        description:
          'Retrieve the full payload of a large tool result that was offloaded (JIT) to keep the agent context small. Pass the result_id shown in the truncated response, plus page (0-based) to page through a large payload. Read/compute; mutates nothing.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        result_id: z.string().min(1).describe('The result_id from a JIT-offloaded tool response.'),
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
      handler: async (input) => {
        const r = await fetchStoredResult(input.result_id, input.page ?? 0);
        const summary = r.found
          ? `result ${input.result_id}: page ${(r.page ?? 0) + 1}/${r.pages} (${r.total_bytes} chars total)`
          : r.expired
            ? `result ${input.result_id} has expired (offloaded results are short-lived).`
            : `no stored result for ${input.result_id} (invalid id or expired).`;
        return { data: r, summary };
      },
    },
    callerHash,
  );
}

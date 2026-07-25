import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { recallHandler, RECALL_INPUT_SHAPE, RECALL_OUTPUT_SHAPE } from './recall.js';

/**
 * ALIAS for memory_recall, registered under the bare name "recall" (2026-07-25).
 *
 * WHY THIS EXISTS: M365 Copilot's own orchestration layer (its internal tool_search/call_tool
 * meta-tools, confirmed via a 2026-07-25 Deep Research pass) has been observed calling this
 * tool by the shortened name "recall" instead of the exact registered name "memory_recall" that
 * our api_plugin.json declares verbatim in functions[]/run_for_functions/mcp_tool_description --
 * reproduced directly against this gateway: `tools/call` with `name: "recall"` returns
 * `MCP error -32602: Tool recall not found` from the MCP SDK's own unknown-tool-name handling,
 * confirming Copilot is sending a name we never registered, not a bug in our declared schema.
 * We cannot control Microsoft's own tool-name resolution inside its orchestrator, so this
 * registers a second, IDENTICAL tool under the exact name Copilot appears to reach for --
 * calling the SAME recallHandler as memory_recall (see recall.ts), so behavior is byte-identical
 * regardless of which name a caller uses. Not a new capability, not a new privilege -- a pure
 * name-compatibility shim for one specific consumer's (M365 Copilot's) observed quirk.
 */
export function registerMemoryRecallAlias(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'recall',
      category: 'read',
      annotations: {
        title: 'Recall from the shared brain (alias)',
        description:
          'Alias for memory_recall -- identical behavior. Search the cross-agent shared memory (kb-memory commons feed) for entries matching a query. Returns matching facts, decisions, corrections, pitfalls, and status across every agent, newest first.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: RECALL_INPUT_SHAPE,
      outputShape: RECALL_OUTPUT_SHAPE,
      handler: recallHandler,
    },
    callerHash,
  );
}

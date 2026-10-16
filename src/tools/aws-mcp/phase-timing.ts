import type { ToolTimingOutcome } from '../../audit/tool-timing.js';

/** A timed out write may have reached AWS; preserve that uncertainty in the operation observation. */
export function awsMcpErrorOutcome(code: string | undefined, phase: string): ToolTimingOutcome {
  if (phase === 'operation' && code === 'aws_mcp_timeout') return 'unknown';
  if (code === 'aws_mcp_rejected' || code === 'aws_mcp_busy' || code === 'aws_mcp_throttled') return 'rejected';
  return 'error';
}

/** MCP action errors are valid protocol responses but failed operations. */
export function awsMcpActionOutcome(isError: boolean): ToolTimingOutcome {
  return isError ? 'error' : 'success';
}

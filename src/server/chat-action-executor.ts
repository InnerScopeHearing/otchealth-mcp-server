import { handleBrainSearch } from '../tools/kb/brain-search.js';
import type { ToolContext } from '../tools/registry.js';
import type { ChatActionExecutor } from './chat-action-worker.js';

const COMPANY_LANES = new Set(['cto', 'developer', 'coo', 'cro', 'cfo', 'clo', 'exec']);

export function createChatActionExecutor(checkpoint: (request: Record<string, unknown>, context: ToolContext) => Promise<unknown>): ChatActionExecutor {
  return {
    async brainSearch(request, context) {
      if (!COMPANY_LANES.has(context.callerAgent)) throw new Error('chat_action_caller_lane_not_allowed');
      const result = await handleBrainSearch(request as never, { callerHash: context.callerHash, callerAgent: context.callerAgent, correlationId: context.correlationId, dryRun: false, acknowledgeWarning: false });
      return result.data;
    },
    async checkpoint(request, context) {
      if (!COMPANY_LANES.has(context.callerAgent)) throw new Error('chat_action_caller_lane_not_allowed');
      return checkpoint(request, { callerHash: context.callerHash, callerAgent: context.callerAgent, correlationId: context.correlationId, dryRun: false, acknowledgeWarning: false });
    },
  };
}

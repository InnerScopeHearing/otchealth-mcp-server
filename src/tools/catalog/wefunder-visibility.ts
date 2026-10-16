const DENIED_WEFUNDER_CHAT_ACTION_TOOLS = new Set([
  'chat_action_submit',
  'chat_action_status',
  'chat_action_result',
]);

/** Removes the denied n8n chat-action bridge from the WeFunder connector advertisement. */
export function hideDeniedWefunderChatActions(toolNames: readonly string[]): string[] {
  return toolNames.filter((name) => !DENIED_WEFUNDER_CHAT_ACTION_TOOLS.has(name));
}

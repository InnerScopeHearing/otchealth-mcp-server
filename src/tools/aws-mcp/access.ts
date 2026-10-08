/**
 * Who may use the AWS MCP bridge, and the operator kill switch.
 *
 * Every check here runs BEFORE any credential, STS or network use, and each failure is a typed
 * AwsMcpRefusalError whose message is safe to show the caller.
 *
 * ACCEPTED CALLER: the CTO lane, over an OAuth-authenticated session only (the claude.ai connector
 * path). The CTO lane is also reachable with static credentials, and none of them may reach an AWS
 * identity: the connector token bound to the default agent, the CTO's M365 declarative-agent token
 * (it is part of a published manifest URL), the Codex per-seat tokens, and the Copilot and eval
 * tokens. Static secrets get copied into manifests, config files and shell histories; an OAuth
 * session is issued to an interactive client and expires. validateBearer records how each request
 * authenticated (AuthKind), and the bridge accepts 'oauth' only: a Descope session, every static
 * kind, and a request whose path never recorded a kind are all refused.
 *
 * KILL SWITCH: AWS_MCP_BRIDGE_DISABLED=true (also 1, yes, on) makes both tools refuse at once. It is
 * read on every call, after the caller checks, and before any credential or network use.
 */
import type { AuthKind } from '../../server/request-context.js';

export const AWS_MCP_BRIDGE_DISABLED_ENV = 'AWS_MCP_BRIDGE_DISABLED';
/** The one authentication kind the bridge serves. */
export const AWS_MCP_ACCEPTED_AUTH_KIND: AuthKind = 'oauth';

export type AwsMcpRefusalCode =
  | 'aws_mcp_forbidden'
  | 'aws_mcp_disabled'
  | 'aws_mcp_invalid_input'
  | 'aws_mcp_tool_blocked'
  | 'aws_mcp_tool_not_allowed';

/** A refusal made by the bridge itself, before any AWS request. The message starts with the code. */
export class AwsMcpRefusalError extends Error {
  readonly code: AwsMcpRefusalCode;
  constructor(code: AwsMcpRefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AwsMcpRefusalError';
    this.code = code;
  }
}

/** What the access check needs to know about the caller. */
export interface AwsMcpCaller {
  callerAgent: string;
  /** How the request authenticated, or undefined when no kind was recorded. */
  authKind?: AuthKind;
}

/** True when the operator has switched the bridge off. */
export function bridgeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env[AWS_MCP_BRIDGE_DISABLED_ENV] ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

/** A short, log-safe label for an auth kind (never anything but a lowercase token). */
function kindLabel(kind: string): string {
  return /^[a-z0-9-]{1,16}$/.test(kind) ? kind : 'unrecognized';
}

/**
 * Refuse unless the caller is the CTO lane on an OAuth session and the kill switch is off.
 * Order: lane, authentication kind, kill switch. Throws AwsMcpRefusalError.
 */
export function assertBridgeAccess(caller: AwsMcpCaller, env: Record<string, string | undefined> = process.env): void {
  if (caller.callerAgent !== 'cto') {
    throw new AwsMcpRefusalError('aws_mcp_forbidden', 'the AWS bridge is available to the CTO lane only.');
  }
  if (caller.authKind !== AWS_MCP_ACCEPTED_AUTH_KIND) {
    const how =
      caller.authKind === undefined
        ? 'this session does not record how it authenticated'
        : `this session authenticated with a "${kindLabel(caller.authKind)}" credential, which is not an OAuth session`;
    throw new AwsMcpRefusalError(
      'aws_mcp_forbidden',
      `the AWS bridge serves OAuth-authenticated CTO sessions only (the claude.ai connector), and ${how}. ` +
        'Static tokens and other credential types are refused. No AWS request was made.',
    );
  }
  if (bridgeDisabled(env)) {
    throw new AwsMcpRefusalError(
      'aws_mcp_disabled',
      `the AWS bridge is switched off by the operator (${AWS_MCP_BRIDGE_DISABLED_ENV}). No AWS request was made.`,
    );
  }
}

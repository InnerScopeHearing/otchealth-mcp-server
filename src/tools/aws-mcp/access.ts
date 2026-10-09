/**
 * Who may use the AWS MCP bridge, and the operator kill switch.
 *
 * Every check here runs BEFORE any credential, STS or network use, and each failure is a typed
 * AwsMcpRefusalError whose message is safe to show the caller.
 *
 * ACCEPTED CALLER: the CTO lane, over an OAuth-issued session only: a token the gateway's own OAuth
 * endpoints issued through the authorization_code grant (the claude.ai connector flow), or through the
 * refresh_token grant that renews one. The CTO lane is also reachable with static credentials, and the
 * bridge refuses every one of them directly: the connector token bound to the default agent, the CTO's
 * M365 declarative-agent token (it is part of a published manifest URL), the Codex per-seat tokens, and
 * the Copilot and eval tokens. Static secrets get copied into manifests, config files and shell
 * histories. validateBearer records how each request authenticated (AuthKind), and the bridge accepts
 * 'oauth' only: a Descope session, every static kind, and a request whose path never recorded a kind
 * are all refused.
 *
 * The OAuth grant matters as well. The token endpoint stamps the grant into every access token it
 * signs (`gty`, server/oauth.ts, read back by validateBearer as auth_grant). A token from the
 * authorization_code grant, and from the refresh_token grant that renews it, is accepted. A
 * client_credentials token is a machine credential (a client id plus a secret, no code exchange) and
 * is refused; so is a token that records no grant (minted before grant tracking, so it cannot be shown
 * to come from an accepted grant).
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. The check proves how the token was ISSUED. It does not prove
 * that a person is present. A holder of a static CTO-lane credential can still reach the bridge through
 * an authorization_code session: connector_setup_code_create mints a setup code, a DCR client registers
 * anonymously, and the consent endpoint redeems the code with plain HTTP and no browser; and a
 * confidential client's authorization code is issued with no consent screen at all. Those paths belong
 * to the setup-code tool and the OAuth endpoints, not to this check, and hardening them is tracked as a
 * separate follow-up. What bounds that path is the read-only reader role (ViewOnlyAccess plus explicit
 * denies on secret and data-content reads).
 *
 * KILL SWITCH: AWS_MCP_BRIDGE_DISABLED. It fails closed: both tools refuse unless the value is blank,
 * false, 0, no or off (any case), so a typo such as "ture" or "enabled" disables the bridge instead of
 * leaving it on. The value is read on every call, after the caller checks and before any credential or
 * network use, but a running task's environment does not change: the switch takes effect when the task
 * restarts with the new environment.
 */
import type { AuthKind, OAuthGrantType } from '../../server/request-context.js';

export const AWS_MCP_BRIDGE_DISABLED_ENV = 'AWS_MCP_BRIDGE_DISABLED';
/** The one authentication kind the bridge serves. */
export const AWS_MCP_ACCEPTED_AUTH_KIND: AuthKind = 'oauth';
/** The OAuth grants the bridge serves: the authorization_code exchange and the refresh_token grant that renews it. Never client_credentials. */
export const AWS_MCP_ACCEPTED_AUTH_GRANTS: readonly OAuthGrantType[] = ['authorization_code', 'refresh_token'];
/** The only values of the kill switch that leave the bridge enabled (compared in lowercase, surrounding space ignored). */
export const AWS_MCP_BRIDGE_ENABLED_VALUES: readonly string[] = ['', 'false', '0', 'no', 'off'];

export type AwsMcpRefusalCode =
  | 'aws_mcp_forbidden'
  | 'aws_mcp_grant_refused'
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
  /** For an OAuth request, the grant that issued its token, or undefined when the token records none. */
  authGrant?: OAuthGrantType;
}

/**
 * True unless the operator has explicitly left the bridge enabled. Fails closed: every value except a
 * blank one, false, 0, no or off (any case, surrounding space ignored) disables the bridge, so a typo
 * cannot leave AWS reachable.
 */
export function bridgeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env[AWS_MCP_BRIDGE_DISABLED_ENV] ?? '').trim().toLowerCase();
  return !AWS_MCP_BRIDGE_ENABLED_VALUES.includes(value);
}

/** A short, log-safe label for an auth kind (never anything but a lowercase token). */
function kindLabel(kind: string): string {
  return /^[a-z0-9-]{1,16}$/.test(kind) ? kind : 'unrecognized';
}

/** The same for a grant name, which is lowercase letters and underscores. */
function grantLabel(grant: string): string {
  return /^[a-z_]{1,32}$/.test(grant) ? grant : 'unrecognized';
}

/**
 * Refuse unless the caller is the CTO lane on an OAuth-issued session (a token from the
 * authorization_code or refresh_token grant) and the kill switch is not on.
 * Order: lane, authentication kind, OAuth grant, kill switch. Throws AwsMcpRefusalError.
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
  if (caller.authGrant === undefined || !AWS_MCP_ACCEPTED_AUTH_GRANTS.includes(caller.authGrant)) {
    const how =
      caller.authGrant === undefined
        ? 'this token does not record how it was issued, so it cannot be shown to come from the authorization_code or refresh_token grant ' +
          '(a token minted before grant tracking has none, so reconnect the connector to get a fresh one)'
        : caller.authGrant === 'client_credentials'
          ? 'this token was issued by the client_credentials grant, which is a machine credential'
          : `this token records a "${grantLabel(caller.authGrant)}" grant, which the bridge does not accept`;
    throw new AwsMcpRefusalError(
      'aws_mcp_grant_refused',
      'the AWS bridge serves OAuth-issued sessions only (a token from the authorization_code grant, or from the refresh_token grant that renews it), ' +
        `and ${how}. No AWS request was made.`,
    );
  }
  if (bridgeDisabled(env)) {
    throw new AwsMcpRefusalError(
      'aws_mcp_disabled',
      `the AWS bridge is switched off (${AWS_MCP_BRIDGE_DISABLED_ENV} is set to something other than blank, false, 0, no or off). No AWS request was made.`,
    );
  }
}

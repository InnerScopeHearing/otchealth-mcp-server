/**
 * One structured audit line per AWS bridge call, written through the gateway logger (pino with the
 * gateway's redaction rules).
 *
 * WHAT THE LINE HOLDS: the gateway tool, the correlation id, the hashed caller, how the caller
 * authenticated, the upstream tool and region, the SHA-256 of a run_script `script` argument, the
 * size of the upstream response, whether the call ended in error and with which error code, and the
 * RoleSessionName of the reader role session used (the join key to CloudTrail). Together these answer
 * "who ran what against the AWS account, and what came back" without recording any of the content.
 *
 * WHAT IT NEVER HOLDS: credentials, signatures, tokens, argument values or script text. The line is
 * built from an allowlist of fields, and every value is either an enumerated constant, a number, a
 * boolean or a short string that matched a strict pattern; anything else is replaced, so a field can
 * never carry free text. Refusals are logged too (at warn level), so an attempt to use the bridge
 * with a static credential leaves a record naming that credential's kind.
 */
import { createHash } from 'node:crypto';
import { logger } from '../../audit/logger.js';
import { AwsMcpRefusalError } from './access.js';
import { AwsReaderUnavailableError } from './credentials.js';
import { AwsMcpBridgeError } from './upstream.js';

export const AWS_MCP_AUDIT_LOG_TYPE = 'aws_mcp_bridge_call';

export type BridgeToolName = 'aws_mcp_tool_list' | 'aws_mcp_tool_call';
export type BridgeCallOutcome = 'ok' | 'upstream_error' | 'refused' | 'error';

/** Error code recorded when the upstream tool itself reported an error (the bridge call completed). */
export const UPSTREAM_TOOL_ERROR_CODE = 'aws_mcp_upstream_tool_error';

export interface BridgeCallAuditEntry {
  bridgeTool: BridgeToolName;
  correlationId: string;
  callerHash: string;
  /** How the caller authenticated, or undefined when none was recorded. */
  authKind: string | undefined;
  upstreamTool?: string;
  region?: string;
  /** SHA-256 (hex) of an aws___run_script `script` argument. The script text itself is never logged. */
  scriptSha256?: string;
  /** UTF-8 bytes of the upstream response as received. */
  responseBytes?: number;
  isError: boolean;
  errorCode?: string;
  outcome: BridgeCallOutcome;
  /** RoleSessionName of the reader role session that served the call. */
  roleSessionName?: string;
  latencyMs?: number;
}

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const KIND_PATTERN = /^[a-z0-9-]{1,16}$/;
const UPSTREAM_TOOL_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9+=,.@_-]{1,64}$/;

function matching(value: string | undefined, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

/** SHA-256 of a string as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The error code to record for a thrown error. Never derived from free text. */
export function errorCodeOf(err: unknown): string {
  if (err instanceof AwsMcpRefusalError || err instanceof AwsMcpBridgeError || err instanceof AwsReaderUnavailableError) {
    return err.code;
  }
  return 'aws_mcp_internal_error';
}

/** Whether a thrown error is a policy refusal made before any AWS request, or a failure. */
export function outcomeOfError(err: unknown): 'refused' | 'error' {
  return err instanceof AwsMcpRefusalError ? 'refused' : 'error';
}

/** The structured fields of an audit line. Exported so tests can assert on them directly. */
export function bridgeCallLogFields(entry: BridgeCallAuditEntry): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    type: AWS_MCP_AUDIT_LOG_TYPE,
    bridge_tool: entry.bridgeTool,
    correlation_id: matching(entry.correlationId, ID_PATTERN) ?? 'invalid',
    caller_hash: matching(entry.callerHash, ID_PATTERN) ?? 'unknown',
    auth_kind: matching(entry.authKind, KIND_PATTERN) ?? 'none',
    outcome: entry.outcome,
    is_error: entry.isError === true,
  };
  const upstreamTool = matching(entry.upstreamTool, UPSTREAM_TOOL_PATTERN);
  if (upstreamTool) fields.upstream_tool = upstreamTool;
  const region = matching(entry.region, REGION_PATTERN);
  if (region) fields.region = region;
  const scriptSha256 = matching(entry.scriptSha256, SHA256_PATTERN);
  if (scriptSha256) fields.script_sha256 = scriptSha256;
  if (Number.isInteger(entry.responseBytes) && (entry.responseBytes as number) >= 0) fields.response_bytes = entry.responseBytes;
  const errorCode = matching(entry.errorCode, ERROR_CODE_PATTERN);
  if (errorCode) fields.error_code = errorCode;
  const roleSessionName = matching(entry.roleSessionName, SESSION_NAME_PATTERN);
  if (roleSessionName) fields.role_session_name = roleSessionName;
  if (Number.isInteger(entry.latencyMs) && (entry.latencyMs as number) >= 0) fields.latency_ms = entry.latencyMs;
  return fields;
}

/** Write one audit line. Logging can never fail a call: any error here is swallowed. */
export function logBridgeCall(entry: BridgeCallAuditEntry): void {
  try {
    const fields = bridgeCallLogFields(entry);
    const message = `aws_mcp_bridge_call ${entry.bridgeTool} ${entry.outcome}`;
    if (entry.outcome === 'ok' || entry.outcome === 'upstream_error') logger.info(fields, message);
    else logger.warn(fields, message);
  } catch {
    // an audit failure must never change the result of the call
  }
}

export interface BridgeCallAuditBase {
  bridgeTool: BridgeToolName;
  correlationId: string;
  callerHash: string;
  authKind: string | undefined;
}

/** Collects what is known about one call and writes exactly one audit line when it ends. */
export class BridgeCallAudit {
  private emitted = false;
  private readonly startedAtMs = Date.now();
  private upstreamTool: string | undefined;
  private region: string | undefined;
  private scriptSha256: string | undefined;

  constructor(private readonly base: BridgeCallAuditBase) {}

  /** Record request details as they are validated. Only validated values may be passed. */
  note(details: { upstreamTool?: string; region?: string; scriptSha256?: string }): void {
    if (details.upstreamTool !== undefined) this.upstreamTool = details.upstreamTool;
    if (details.region !== undefined) this.region = details.region;
    if (details.scriptSha256 !== undefined) this.scriptSha256 = details.scriptSha256;
  }

  /** The call completed. `isError` is true when the upstream tool itself reported an error. */
  success(result: { responseBytes: number; isError: boolean; roleSessionName?: string }): void {
    this.emit({
      isError: result.isError,
      outcome: result.isError ? 'upstream_error' : 'ok',
      responseBytes: result.responseBytes,
      errorCode: result.isError ? UPSTREAM_TOOL_ERROR_CODE : undefined,
      roleSessionName: result.roleSessionName,
    });
  }

  /** The call was refused or failed. */
  failure(err: unknown): void {
    this.emit({ isError: true, outcome: outcomeOfError(err), errorCode: errorCodeOf(err) });
  }

  private emit(
    result: Pick<BridgeCallAuditEntry, 'isError' | 'outcome' | 'responseBytes' | 'errorCode' | 'roleSessionName'>,
  ): void {
    if (this.emitted) return;
    this.emitted = true;
    logBridgeCall({
      ...this.base,
      upstreamTool: this.upstreamTool,
      region: this.region,
      scriptSha256: this.scriptSha256,
      latencyMs: Date.now() - this.startedAtMs,
      ...result,
    });
  }
}

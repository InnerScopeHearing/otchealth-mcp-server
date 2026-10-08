/**
 * Durable, read-only AWS identity for the CTO-lane AWS MCP bridge.
 *
 * The bridge never signs a request to the AWS MCP Server with the gateway's own task-role
 * credentials. It signs only with short-lived credentials from STS AssumeRole into a dedicated
 * read-only role (default `otchealth-ai-reader-role`, ViewOnlyAccess plus explicit denies on secret
 * and data-content reads). The gateway task role is used for exactly two STS calls and nothing
 * else: GetCallerIdentity (to learn the account id) and AssumeRole.
 *
 * FAIL CLOSED: if the reader role cannot be assumed for any reason (it does not exist yet, the trust
 * policy does not name the gateway task role, STS is unreachable, the response is malformed, the
 * override ARN is invalid), every caller gets an AwsReaderUnavailableError. There is no code path
 * that returns the base credentials, an environment key, or any other identity as a substitute.
 *
 * The error message is written to be shown to the CTO: it carries only an enumerated reason and the
 * STS error code (a short token such as AccessDenied). STS error message text, ARNs, account ids,
 * credentials and session tokens are never placed in it, and nothing here logs them.
 *
 * Base credentials come from src/search/sigv4.ts resolveAwsCredentials(): AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY when set, otherwise the ECS task-role container credential endpoint. The
 * production task definition sets no AWS_ACCESS_KEY_ID, so the ECS task role is the base identity.
 */
import { randomBytes } from 'node:crypto';
import { logger } from '../../audit/logger.js';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';

export const AWS_AI_READER_ROLE_NAME = 'otchealth-ai-reader-role';
export const AWS_AI_READER_ROLE_ARN_ENV = 'AWS_AI_READER_ROLE_ARN';
/** The owner-run CloudShell script that creates the reader role. Named in the fail-closed message. */
export const AWS_AI_ACCESS_SETUP_SCRIPT = 'setup/iam/aws-ai-access-2026-10-07.sh';

const STS_REGION = 'us-east-1';
const STS_HOST = `sts.${STS_REGION}.amazonaws.com`;
const STS_API_VERSION = '2011-06-15';
const STS_REQUEST_TIMEOUT_MS = 8_000;
const STS_MAX_RESPONSE_CHARS = 64 * 1024;
/** Role chaining caps a session at one hour, so this is both the request and the maximum. */
const SESSION_DURATION_SECONDS = 3600;
/** Credentials are refreshed once they are within this margin of their expiry. */
export const READER_CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000;
/** A failed refresh may reuse still-valid cached credentials until this close to real expiry. */
const MIN_REUSE_REMAINING_MS = 30_000;

const ROLE_ARN_PATTERN = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const ACCOUNT_ID_PATTERN = /^\d{12}$/;
const STS_ERROR_CODE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ACCESS_KEY_ID_PATTERN = /^[A-Z0-9]{16,128}$/;

export type ReaderUnavailableReason =
  | 'no_base_credentials'
  | 'invalid_role_arn'
  | 'caller_identity_failed'
  | 'assume_role_failed'
  | 'invalid_sts_response'
  | 'sts_unreachable';

/** Short-lived reader-role credentials. `sessionToken` is always present for an assumed role. */
export interface ReaderCredentials extends AwsCredentials {
  sessionToken: string;
  expiresAtMs: number;
}

export interface ReaderCredentialProvider {
  /** Cached reader credentials, refreshed ahead of expiry. `sessionHint` only names a new session. */
  get(sessionHint?: string): Promise<ReaderCredentials>;
  /** Drop every cached value (tests and operational resets). */
  reset(): void;
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface ReaderCredentialProviderOptions {
  /** Base credentials used ONLY to call STS. Defaults to the shared resolver (env keys or ECS task role). */
  baseCredentials?: () => Promise<AwsCredentials | null>;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Overrides AWS_AI_READER_ROLE_ARN. Mainly for tests; production uses the environment variable. */
  roleArn?: string;
}

/** Thrown for every reason the reader identity is unavailable. The message is safe to show the CTO. */
export class AwsReaderUnavailableError extends Error {
  readonly code = 'aws_mcp_unavailable';
  readonly reason: ReaderUnavailableReason;
  readonly stsCode: string | undefined;

  constructor(reason: ReaderUnavailableReason, stsCode?: string) {
    super(unavailableMessage(reason, stsCode));
    this.name = 'AwsReaderUnavailableError';
    this.reason = reason;
    this.stsCode = stsCode;
  }
}

function unavailableMessage(reason: ReaderUnavailableReason, stsCode: string | undefined): string {
  const detail = stsCode ? `${reason}, STS ${stsCode}` : reason;
  const closed = 'No fallback credentials are used, so the AWS bridge stays closed until this is fixed.';
  switch (reason) {
    case 'assume_role_failed':
      return (
        `aws_mcp_unavailable (${detail}): the gateway could not assume the read-only AWS identity ${AWS_AI_READER_ROLE_NAME}. ` +
        `If that role has not been created yet, the owner must run ${AWS_AI_ACCESS_SETUP_SCRIPT} in AWS CloudShell, then retry. ${closed}`
      );
    case 'invalid_role_arn':
      return (
        `aws_mcp_unavailable (${detail}): ${AWS_AI_READER_ROLE_ARN_ENV} is set but is not a valid IAM role ARN. ` +
        `The owner must correct or unset it. ${closed}`
      );
    case 'no_base_credentials':
      return (
        `aws_mcp_unavailable (${detail}): the gateway has no AWS task-role credentials to start from, ` +
        `which is a gateway runtime problem rather than a role-setup problem. ${closed}`
      );
    case 'sts_unreachable':
      return `aws_mcp_unavailable (${detail}): AWS STS did not answer in time. Retry shortly. ${closed}`;
    case 'caller_identity_failed':
      return (
        `aws_mcp_unavailable (${detail}): the gateway could not look up its own AWS account through STS. ` +
        `Check the gateway task role and network egress. ${closed}`
      );
    case 'invalid_sts_response':
      return `aws_mcp_unavailable (${detail}): AWS STS returned an unexpected response. ${closed}`;
  }
}

function xmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]{0,8192})</${tag}>`).exec(xml);
  return match ? match[1].trim() : undefined;
}

function xmlBlock(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]{0,16384}?)</${tag}>`).exec(xml);
  return match ? match[1] : undefined;
}

/** STS Query-API call signed with the base credentials. Returns the XML body of a 2xx answer. */
async function stsCall(
  params: Record<string, string>,
  base: AwsCredentials,
  fetchImpl: FetchLike,
  nowMs: number,
  failureReason: 'caller_identity_failed' | 'assume_role_failed',
): Promise<string> {
  const body = new URLSearchParams({ ...params, Version: STS_API_VERSION }).toString();
  const { headers } = signRequest({
    method: 'POST',
    host: STS_HOST,
    path: '/',
    body,
    region: STS_REGION,
    service: 'sts',
    credentials: base,
    now: new Date(nowMs),
    extraHeaders: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
  });

  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(`https://${STS_HOST}/`, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(STS_REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch {
    throw new AwsReaderUnavailableError('sts_unreachable');
  }
  if (text.length > STS_MAX_RESPONSE_CHARS) throw new AwsReaderUnavailableError('invalid_sts_response');
  if (!res.ok) {
    const code = xmlTag(text, 'Code');
    throw new AwsReaderUnavailableError(failureReason, code && STS_ERROR_CODE_PATTERN.test(code) ? code : undefined);
  }
  return text;
}

function sessionNameFor(hint: string): string {
  const short = hint.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || randomBytes(4).toString('hex');
  return `gw-cto-${short}`;
}

function roleNameOf(roleArn: string): string {
  return roleArn.slice(roleArn.lastIndexOf('/') + 1);
}

/**
 * Create a credential provider. The module-level default (below) is what the tools use; tests build
 * their own with a mocked fetch and clock so no cache state leaks between cases.
 */
export function createReaderCredentialProvider(options: ReaderCredentialProviderOptions = {}): ReaderCredentialProvider {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const baseCredentials = options.baseCredentials ?? resolveAwsCredentials;

  let cached: ReaderCredentials | undefined;
  let inflight: Promise<ReaderCredentials> | undefined;
  let accountId: string | undefined;

  async function resolveRoleArn(base: AwsCredentials): Promise<string> {
    const override = (options.roleArn ?? process.env[AWS_AI_READER_ROLE_ARN_ENV] ?? '').trim();
    if (override) {
      if (!ROLE_ARN_PATTERN.test(override)) throw new AwsReaderUnavailableError('invalid_role_arn');
      return override;
    }
    if (!accountId) {
      const xml = await stsCall({ Action: 'GetCallerIdentity' }, base, fetchImpl, now(), 'caller_identity_failed');
      const account = xmlTag(xml, 'Account');
      if (!account || !ACCOUNT_ID_PATTERN.test(account)) throw new AwsReaderUnavailableError('invalid_sts_response');
      accountId = account;
    }
    return `arn:aws:iam::${accountId}:role/${AWS_AI_READER_ROLE_NAME}`;
  }

  async function refresh(sessionHint: string): Promise<ReaderCredentials> {
    const base = await baseCredentials().catch(() => null);
    if (!base) throw new AwsReaderUnavailableError('no_base_credentials');
    const roleArn = await resolveRoleArn(base);

    const xml = await stsCall(
      {
        Action: 'AssumeRole',
        RoleArn: roleArn,
        RoleSessionName: sessionNameFor(sessionHint),
        DurationSeconds: String(SESSION_DURATION_SECONDS),
      },
      base,
      fetchImpl,
      now(),
      'assume_role_failed',
    );

    const credentialsBlock = xmlBlock(xml, 'Credentials');
    const assumedBlock = xmlBlock(xml, 'AssumedRoleUser');
    const accessKeyId = credentialsBlock && xmlTag(credentialsBlock, 'AccessKeyId');
    const secretAccessKey = credentialsBlock && xmlTag(credentialsBlock, 'SecretAccessKey');
    const sessionToken = credentialsBlock && xmlTag(credentialsBlock, 'SessionToken');
    const expiration = credentialsBlock && xmlTag(credentialsBlock, 'Expiration');
    const assumedArn = assumedBlock && xmlTag(assumedBlock, 'Arn');
    const expiresAtMs = expiration ? Date.parse(expiration) : Number.NaN;

    if (
      !accessKeyId || !ACCESS_KEY_ID_PATTERN.test(accessKeyId) ||
      !secretAccessKey || secretAccessKey.length > 256 ||
      !sessionToken || sessionToken.length > 8192 ||
      !Number.isFinite(expiresAtMs) ||
      // The credentials must belong to the reader role we asked for, never to some other identity.
      !assumedArn || !assumedArn.includes(`:assumed-role/${roleNameOf(roleArn)}/`)
    ) {
      throw new AwsReaderUnavailableError('invalid_sts_response');
    }

    const fresh: ReaderCredentials = { accessKeyId, secretAccessKey, sessionToken, expiresAtMs };
    cached = fresh;
    return fresh;
  }

  async function refreshOrReuse(sessionHint: string): Promise<ReaderCredentials> {
    try {
      return await refresh(sessionHint);
    } catch (err) {
      // Anything unexpected is reported as a malformed STS answer so no raw error text escapes.
      const failure = err instanceof AwsReaderUnavailableError ? err : new AwsReaderUnavailableError('invalid_sts_response');
      logger.warn(
        { type: 'aws_mcp_reader_unavailable', reason: failure.reason, sts_code: failure.stsCode },
        'AWS reader role credentials could not be refreshed',
      );
      // Reader credentials that are still genuinely valid may be used a little longer: this is the
      // same read-only identity, never a different one, and STS blips should not take the bridge down.
      if (cached && cached.expiresAtMs - now() > MIN_REUSE_REMAINING_MS) return cached;
      cached = undefined;
      throw failure;
    }
  }

  return {
    async get(sessionHint = ''): Promise<ReaderCredentials> {
      if (cached && cached.expiresAtMs - now() > READER_CREDENTIAL_REFRESH_MARGIN_MS) return cached;
      if (!inflight) {
        inflight = refreshOrReuse(sessionHint).finally(() => {
          inflight = undefined;
        });
      }
      return inflight;
    },
    reset(): void {
      cached = undefined;
      inflight = undefined;
      accountId = undefined;
    },
  };
}

/** Process-wide provider used by the registered tools: one credential cache per gateway instance. */
export const readerCredentials: ReaderCredentialProvider = createReaderCredentialProvider();

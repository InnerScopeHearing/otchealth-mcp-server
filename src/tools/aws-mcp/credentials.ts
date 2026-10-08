/**
 * Durable, read-only AWS identity for the CTO-lane AWS MCP bridge.
 *
 * The bridge never signs a request to the AWS MCP Server with the gateway's own task-role
 * credentials. It signs only with short-lived credentials from STS AssumeRole into a dedicated
 * read-only role (`otchealth-ai-reader-role`, ViewOnlyAccess plus explicit denies on secret and
 * data-content reads). The gateway task role is used for exactly two STS calls and nothing else:
 * GetCallerIdentity (to learn the account id) and AssumeRole.
 *
 * THE ROLE IS PINNED. The role assumed is always named `otchealth-ai-reader-role` in the gateway's own
 * account. AWS_AI_READER_ROLE_ARN may only spell that same role (an IAM path before the name is
 * allowed): a different role name, or a role in another account, is refused before any AssumeRole is
 * sent, so a configuration mistake or a tampered environment cannot point the bridge at a more
 * powerful identity. After AssumeRole the returned assumed-role ARN is checked against the same
 * name and account, and the role that was actually assumed is carried on the credentials.
 *
 * FAIL CLOSED: if the reader role cannot be assumed for any reason (it does not exist yet, the trust
 * policy does not name the gateway task role, STS is unreachable, the response is malformed, the
 * override ARN is invalid or not the pinned role), every caller gets an AwsReaderUnavailableError.
 * There is no code path that returns the base credentials, an environment key, or any other identity
 * as a substitute. A failed refresh is remembered for READER_FAILURE_CACHE_MS, and calls inside that
 * window get the same answer without another round trip to STS.
 *
 * The error message is written to be shown to the CTO: it carries only an enumerated reason and the
 * STS error code (a short token such as AccessDenied). STS error message text, ARNs, account ids,
 * credentials and session tokens are never placed in it, and nothing here logs them. Each AssumeRole
 * logs its RoleSessionName (the join key to CloudTrail) and nothing secret.
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
/** The owner-run CloudShell script that creates the reader role, and the repository that holds it. */
export const AWS_AI_ACCESS_SETUP_REPO = 'InnerScopeHearing/otchealth-claude-tools';
export const AWS_AI_ACCESS_SETUP_SCRIPT = 'setup/iam/aws-ai-access-2026-10-07.sh';
/** Exactly how the fail-closed message points the owner at the script. */
export const AWS_AI_ACCESS_SETUP_POINTER = `${AWS_AI_ACCESS_SETUP_REPO} ${AWS_AI_ACCESS_SETUP_SCRIPT} (owner-run CloudShell step)`;

const STS_REGION = 'us-east-1';
const STS_HOST = `sts.${STS_REGION}.amazonaws.com`;
const STS_API_VERSION = '2011-06-15';
const STS_REQUEST_TIMEOUT_MS = 8_000;
/** Cap on an STS answer, enforced while the body is streamed (real answers are about 2 KB). */
const STS_MAX_RESPONSE_BYTES = 64 * 1024;
/** Role chaining caps a session at one hour, so this is both the request and the maximum. */
const SESSION_DURATION_SECONDS = 3600;
/** Credentials are refreshed once they are within this margin of their expiry. */
export const READER_CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000;
/** After a failed refresh, later calls are answered from the cache for this long without calling STS. */
export const READER_FAILURE_CACHE_MS = 60_000;
/** A failed refresh may reuse still-valid cached credentials until this close to real expiry. */
const MIN_REUSE_REMAINING_MS = 30_000;

const ACCOUNT_ID_PATTERN = /^\d{12}$/;
const IAM_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9+=,.@_-]{1,128}$/;
const STS_ERROR_CODE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ACCESS_KEY_ID_PATTERN = /^[A-Z0-9]{16,128}$/;

export type ReaderUnavailableReason =
  | 'no_base_credentials'
  | 'invalid_role_arn'
  | 'role_name_not_allowed'
  | 'role_account_mismatch'
  | 'caller_identity_failed'
  | 'assume_role_failed'
  | 'invalid_sts_response'
  | 'sts_unreachable';

/** Which reader role session a set of credentials came from. */
export interface ReaderIdentity {
  /** The reader role that was assumed: the pinned role name in the gateway's own account. */
  roleArn: string;
  /** The RoleSessionName of this assumption, the join key to CloudTrail's assumed-role identity. */
  roleSessionName: string;
}

/** Short-lived reader-role credentials. `sessionToken` is always present for an assumed role. */
export interface ReaderCredentials extends AwsCredentials, ReaderIdentity {
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
  /** Set when this answer came from the failure cache: seconds until STS is tried again. */
  readonly retryAfterSeconds: number | undefined;

  constructor(reason: ReaderUnavailableReason, stsCode?: string, retryAfterSeconds?: number) {
    super(unavailableMessage(reason, stsCode, retryAfterSeconds));
    this.name = 'AwsReaderUnavailableError';
    this.reason = reason;
    this.stsCode = stsCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** True when this answer was served from the failure cache and STS was not called again. */
  get cached(): boolean {
    return this.retryAfterSeconds !== undefined;
  }
}

function unavailableMessage(reason: ReaderUnavailableReason, stsCode: string | undefined, retryAfterSeconds: number | undefined): string {
  const detail = stsCode ? `${reason}, STS ${stsCode}` : reason;
  const closed = 'No fallback credentials are used, so the AWS bridge stays closed until this is fixed.';
  const cachedNote =
    retryAfterSeconds === undefined
      ? ''
      : ` This failure is cached, so STS is not called again for about ${retryAfterSeconds} more second(s).`;
  switch (reason) {
    case 'assume_role_failed':
      return (
        `aws_mcp_unavailable (${detail}): the gateway could not assume the read-only AWS identity ${AWS_AI_READER_ROLE_NAME}. ` +
        `If that role has not been created yet, the owner must run ${AWS_AI_ACCESS_SETUP_POINTER}, then retry. ${closed}${cachedNote}`
      );
    case 'invalid_role_arn':
      return (
        `aws_mcp_unavailable (${detail}): ${AWS_AI_READER_ROLE_ARN_ENV} is set but is not a valid IAM role ARN. ` +
        `The owner must correct or unset it. ${closed}${cachedNote}`
      );
    case 'role_name_not_allowed':
      return (
        `aws_mcp_unavailable (${detail}): ${AWS_AI_READER_ROLE_ARN_ENV} must name the role ${AWS_AI_READER_ROLE_NAME} ` +
        `(an IAM path before the name is allowed); any other role is refused. The owner must correct or unset it. ${closed}${cachedNote}`
      );
    case 'role_account_mismatch':
      return (
        `aws_mcp_unavailable (${detail}): ${AWS_AI_READER_ROLE_ARN_ENV} names a role in a different AWS account than the ` +
        `gateway task role; only the gateway's own account is accepted. The owner must correct or unset it. ${closed}${cachedNote}`
      );
    case 'no_base_credentials':
      return (
        `aws_mcp_unavailable (${detail}): the gateway has no AWS task-role credentials to start from, ` +
        `which is a gateway runtime problem rather than a role-setup problem. ${closed}${cachedNote}`
      );
    case 'sts_unreachable':
      return `aws_mcp_unavailable (${detail}): AWS STS did not answer in time. Retry shortly. ${closed}${cachedNote}`;
    case 'caller_identity_failed':
      return (
        `aws_mcp_unavailable (${detail}): the gateway could not look up its own AWS account through STS. ` +
        `Check the gateway task role and network egress. ${closed}${cachedNote}`
      );
    case 'invalid_sts_response':
      return `aws_mcp_unavailable (${detail}): AWS STS returned an unexpected response. ${closed}${cachedNote}`;
  }
}

/** Logging must never change the outcome of a credential refresh, so a failing log sink is swallowed. */
function logSafely(level: 'info' | 'warn', fields: Record<string, unknown>, message: string): void {
  try {
    logger[level](fields, message);
  } catch {
    // a broken log sink is not a reason to lose a credential result, or to invent a failure
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

/**
 * Read a response body as text and give up as soon as it exceeds maxBytes. The cap is enforced while
 * the stream is read and the rest of the stream is cancelled, so an oversized or endless answer is
 * never buffered whole. Returns undefined when the cap was exceeded.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
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
  let text: string | undefined;
  try {
    res = await fetchImpl(`https://${STS_HOST}/`, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(STS_REQUEST_TIMEOUT_MS),
    });
    text = await readBodyCapped(res, STS_MAX_RESPONSE_BYTES);
  } catch {
    throw new AwsReaderUnavailableError('sts_unreachable');
  }
  if (text === undefined) throw new AwsReaderUnavailableError('invalid_sts_response');
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

interface ParsedRoleArn {
  account: string;
  /** The role name: the last path segment of the ARN. */
  name: string;
}

/** Parse arn:aws:iam::<12 digits>:role/<optional path>/<name>; undefined when it is not that shape. */
function parseRoleArn(arn: string): ParsedRoleArn | undefined {
  const match = /^arn:aws:iam::(\d{12}):role\/(.{1,512})$/.exec(arn);
  if (!match) return undefined;
  const segments = match[2].split('/');
  if (segments.some((segment) => !IAM_PATH_SEGMENT_PATTERN.test(segment))) return undefined;
  return { account: match[1], name: segments[segments.length - 1] };
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
  /** The last refresh failure and when it stops being served from the cache. */
  let negative: { error: AwsReaderUnavailableError; untilMs: number } | undefined;

  async function taskAccountId(base: AwsCredentials): Promise<string> {
    if (!accountId) {
      const xml = await stsCall({ Action: 'GetCallerIdentity' }, base, fetchImpl, now(), 'caller_identity_failed');
      const account = xmlTag(xml, 'Account');
      if (!account || !ACCOUNT_ID_PATTERN.test(account)) throw new AwsReaderUnavailableError('invalid_sts_response');
      accountId = account;
    }
    return accountId;
  }

  /** The role to assume and the account it must live in: the pinned role in the task role's account. */
  async function resolveRole(base: AwsCredentials): Promise<{ roleArn: string; account: string }> {
    const override = (options.roleArn ?? process.env[AWS_AI_READER_ROLE_ARN_ENV] ?? '').trim();
    let pinned: ParsedRoleArn | undefined;
    if (override) {
      pinned = parseRoleArn(override);
      if (!pinned) throw new AwsReaderUnavailableError('invalid_role_arn');
      // Refused before any STS call: only the reader role itself may be named.
      if (pinned.name !== AWS_AI_READER_ROLE_NAME) throw new AwsReaderUnavailableError('role_name_not_allowed');
    }
    const account = await taskAccountId(base);
    if (pinned) {
      if (pinned.account !== account) throw new AwsReaderUnavailableError('role_account_mismatch');
      return { roleArn: override, account };
    }
    return { roleArn: `arn:aws:iam::${account}:role/${AWS_AI_READER_ROLE_NAME}`, account };
  }

  async function refresh(sessionHint: string): Promise<ReaderCredentials> {
    const base = await baseCredentials().catch(() => null);
    if (!base) throw new AwsReaderUnavailableError('no_base_credentials');
    const { roleArn, account } = await resolveRole(base);

    const roleSessionName = sessionNameFor(sessionHint);
    // One line per AssumeRole: the session name is what CloudTrail records for everything this session does.
    logSafely(
      'info',
      {
        type: 'aws_mcp_assume_role',
        role_name: AWS_AI_READER_ROLE_NAME,
        role_session_name: roleSessionName,
        duration_seconds: SESSION_DURATION_SECONDS,
      },
      'assuming the AWS reader role',
    );
    const xml = await stsCall(
      {
        Action: 'AssumeRole',
        RoleArn: roleArn,
        RoleSessionName: roleSessionName,
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
      // The credentials must belong to the reader role in the gateway's own account, never to some other identity.
      !assumedArn || !assumedArn.startsWith(`arn:aws:sts::${account}:assumed-role/${AWS_AI_READER_ROLE_NAME}/`)
    ) {
      throw new AwsReaderUnavailableError('invalid_sts_response');
    }

    const fresh: ReaderCredentials = { accessKeyId, secretAccessKey, sessionToken, expiresAtMs, roleArn, roleSessionName };
    cached = fresh;
    negative = undefined;
    return fresh;
  }

  async function refreshOrReuse(sessionHint: string): Promise<ReaderCredentials> {
    try {
      return await refresh(sessionHint);
    } catch (err) {
      // Anything unexpected is reported as a malformed STS answer so no raw error text escapes.
      const failure = err instanceof AwsReaderUnavailableError ? err : new AwsReaderUnavailableError('invalid_sts_response');
      logSafely(
        'warn',
        { type: 'aws_mcp_reader_unavailable', reason: failure.reason, sts_code: failure.stsCode },
        'AWS reader role credentials could not be refreshed',
      );
      // Later calls get this same answer from the cache for a while instead of reaching STS again.
      negative = { error: failure, untilMs: now() + READER_FAILURE_CACHE_MS };
      // Reader credentials that are still genuinely valid may be used a little longer: this is the
      // same read-only identity, never a different one, and STS blips should not take the bridge down.
      if (cached && cached.expiresAtMs - now() > MIN_REUSE_REMAINING_MS) return cached;
      cached = undefined;
      throw failure;
    }
  }

  return {
    async get(sessionHint = ''): Promise<ReaderCredentials> {
      const at = now();
      if (cached && cached.expiresAtMs - at > READER_CREDENTIAL_REFRESH_MARGIN_MS) return cached;
      if (negative && at < negative.untilMs) {
        // A refresh failed a moment ago: STS is not asked again until the failure cache runs out.
        if (cached && cached.expiresAtMs - at > MIN_REUSE_REMAINING_MS) return cached;
        const retryAfterSeconds = Math.max(1, Math.ceil((negative.untilMs - at) / 1000));
        throw new AwsReaderUnavailableError(negative.error.reason, negative.error.stsCode, retryAfterSeconds);
      }
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
      negative = undefined;
    },
  };
}

/** Process-wide provider used by the registered tools: one credential cache per gateway instance. */
export const readerCredentials: ReaderCredentialProvider = createReaderCredentialProvider();

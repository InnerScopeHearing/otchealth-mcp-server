/**
 * Hand-rolled AWS Signature Version 4 (SigV4) request signing, for Amazon OpenSearch (service
 * `es`). This repo intentionally carries NO aws-sdk dependency (see package.json / CLAUDE.md), so
 * this implements the canonical-request algorithm directly with node:crypto -- no third-party
 * signing library, no aws-sdk-client-* package added.
 *
 * Reference: AWS "Signature Version 4 signing process" (canonical request -> string to sign ->
 * derived signing key via an HMAC chain -> Authorization header). This is a general-purpose SigV4
 * signer; nothing here is OpenSearch-specific beyond the default service name ('es') and the
 * caller always sending a JSON body (see signRequest's contentType handling below).
 *
 * CREDENTIAL RESOLUTION (see also src/config/env.ts's OPENSEARCH_ and AWS_ var doc comments):
 *   1. Explicit AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional AWS_SESSION_TOKEN) env vars.
 *   2. The ECS task-role container credential endpoint, when AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
 *      is set (injected automatically by the ECS agent on a task with an attached IAM role) --
 *      short-lived creds fetched from the fixed link-local metadata host and cached until shortly
 *      before their reported expiry.
 * Both paths return a plain object; nothing here talks to the EC2/EKS instance-metadata service
 * (IMDS) or any other credential provider -- out of scope for "env vars or the ECS task role" as
 * specified.
 */
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** RFC3986-strict URI encoding (AWS's canonical-request spec requires encoding `!*'()` too, which
 *  JS's built-in encodeURIComponent leaves unescaped). `keepSlash` controls whether '/' segments in
 *  a canonical URI stay unescaped (true for the path) or get escaped too (used when re-encoding a
 *  single path SEGMENT, never the full path). */
function rfc3986Encode(value: string, keepSlash: boolean): string {
  let out = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (keepSlash) out = out.replace(/%2F/g, '/');
  return out;
}

/** Canonicalize a URI path per SigV4: each segment individually percent-encoded, '/' preserved. An
 *  empty path canonicalizes to '/'. */
export function canonicalUri(path: string): string {
  if (!path || path === '/') return '/';
  return path
    .split('/')
    .map((seg) => rfc3986Encode(seg, false))
    .join('/');
}

/** Canonicalize a query string per SigV4: parameters sorted by encoded key (then encoded value),
 *  '=' always present even for a valueless key. Accepts either a raw query string (no leading '?')
 *  or a plain key/value record. */
export function canonicalQueryString(query: string | Record<string, string> | undefined): string {
  if (!query) return '';
  const pairs: Array<[string, string]> =
    typeof query === 'string'
      ? [...new URLSearchParams(query).entries()]
      : Object.entries(query);
  return pairs
    .map(([k, v]) => [rfc3986Encode(k, false), rfc3986Encode(v, false)] as [string, string])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Derive the SigV4 signing key for a given date/region/service, per the standard HMAC chain:
 *  kDate -> kRegion -> kService -> kSigning. `dateStamp` is YYYYMMDD (UTC). */
export function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export interface SignedRequest {
  headers: Record<string, string>;
}

/**
 * Sign one request. Returns the FULL header set to send (including x-amz-date, host,
 * Authorization, and content-type when a body is present) -- the caller does not need to build any
 * of these itself beyond passing them in here.
 *
 * `contentType`, when the request has a body, IS a signed header (per the task spec: "for
 * OpenSearch the content-type header is application/json and it IS a signed header") -- so it must
 * be included in `extraHeaders` (or left to the 'application/json' default below) and is always
 * part of the canonical/signed-headers set whenever `body` is non-empty.
 */
export function signRequest(opts: {
  method: string;
  host: string;
  path: string;
  query?: string | Record<string, string>;
  /**
   * Request payload. `Buffer` is accepted alongside `string` (2026-08-18) because the S3 WRITE path
   * signs BINARY bodies, and the payload hash on the canonical request's last line MUST be the hash
   * of the exact bytes sent. Hashing a binary body via a JS string is not merely inelegant, it is
   * WRONG: `createHash().update(str)` encodes as UTF-8, so any byte sequence that is not valid UTF-8
   * hashes to something other than the bytes on the wire, and S3 answers 403 SignatureDoesNotMatch.
   * `sha256Hex` already accepts Buffer, so widening the type is the whole change -- no branch, and
   * every existing string caller is unaffected.
   */
  body?: string | Buffer;
  region: string;
  service?: string;
  credentials: AwsCredentials;
  /** Defaults to now; a fixed Date makes this deterministic for tests. */
  now?: Date;
  extraHeaders?: Record<string, string>;
}): SignedRequest {
  const service = opts.service ?? 'es';
  const now = opts.now ?? new Date();
  const amzDate = now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const bodyHash = sha256Hex(opts.body ?? '');

  const headersToSign: Record<string, string> = {
    host: opts.host,
    'x-amz-date': amzDate,
    ...opts.extraHeaders,
  };
  if (opts.body !== undefined && opts.body !== '') {
    headersToSign['content-type'] = headersToSign['content-type'] ?? 'application/json';
  }
  if (opts.credentials.sessionToken) {
    headersToSign['x-amz-security-token'] = opts.credentials.sessionToken;
  }

  // Canonical headers: lowercase name, trimmed value, sorted by name; each on its own line,
  // trailing newline after the last.
  const sortedNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headersToSign[n].trim()}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    opts.method.toUpperCase(),
    canonicalUri(opts.path),
    canonicalQueryString(opts.query),
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const scope = `${dateStamp}/${opts.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = deriveSigningKey(opts.credentials.secretAccessKey, dateStamp, opts.region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const outHeaders: Record<string, string> = { ...headersToSign, Authorization: authorization };
  return { headers: outHeaders };
}

// --- credential resolution --------------------------------------------------------------------

let cachedContainerCreds: { creds: AwsCredentials; expiresAtMs: number } | undefined;

/** ECS container-credentials host, per AWS docs. Fixed link-local address, never DNS-resolved. */
const ECS_CREDENTIALS_HOST = 'http://169.254.170.2';

async function fetchContainerCredentials(): Promise<AwsCredentials | null> {
  const relativeUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const fullUri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  const url = fullUri || (relativeUri ? `${ECS_CREDENTIALS_HOST}${relativeUri}` : undefined);
  if (!url) return null;

  const now = Date.now();
  if (cachedContainerCreds && cachedContainerCreds.expiresAtMs - now > 60_000) {
    return cachedContainerCreds.creds;
  }

  const headers: Record<string, string> = {};
  const authToken = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  if (authToken) headers.Authorization = authToken;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    AccessKeyId?: string;
    SecretAccessKey?: string;
    Token?: string;
    Expiration?: string;
  };
  if (!j.AccessKeyId || !j.SecretAccessKey) return null;
  const creds: AwsCredentials = {
    accessKeyId: j.AccessKeyId,
    secretAccessKey: j.SecretAccessKey,
    sessionToken: j.Token,
  };
  const expiresAtMs = j.Expiration ? Date.parse(j.Expiration) : now + 10 * 60_000;
  cachedContainerCreds = { creds, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : now + 10 * 60_000 };
  return creds;
}

/**
 * Resolve AWS credentials: explicit env vars first (the must-have path), then the ECS task-role
 * container credential endpoint as a fallback. Returns null when neither is available -- callers
 * treat that as "OpenSearch not configured", never throw.
 */
export async function resolveAwsCredentials(): Promise<AwsCredentials | null> {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN || undefined };
  }
  try {
    return await fetchContainerCredentials();
  } catch {
    return null;
  }
}

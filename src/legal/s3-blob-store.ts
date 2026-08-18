/**
 * S3 read backend for the document stores — the other half of the Azure exit.
 *
 * WHY. `src/legal/blob-store.ts` talks only to Azure Blob. The brain finds a document via search
 * (already movable to OpenSearch) but then fetches its CONTENTS from Azure, so `kb_get_document`,
 * `legal_blob_get` and every `_TEXT/` sidecar read stay hard-dependent on Azure. A DNS cutover
 * therefore does NOT survive an Azure suspension: search works, and every document comes back empty.
 *
 * The documents were already mirrored to S3 (~130,000 objects, ~31 GB). Only the read path was
 * missing. This module supplies it, selected by `BLOB_BACKEND` exactly as `SEARCH_BACKEND` selects
 * the search engine.
 *
 * ============================ RING SAFETY IS THE WHOLE DESIGN ============================
 *
 * The mirror is deliberately split across TWO buckets, and that split is a privilege boundary, not
 * a storage detail:
 *
 *   otchealth-legal-personal-dr-*   attorney-privileged personal legal ONLY (CA family/civil
 *                                   matters, minors' data). PERSONAL_LEGAL_RING: clo-personal+exec.
 *   otchealth-finance-legal-dr-*    everything else: company legal, CFO finance, exec.
 *
 * A mapping bug here re-creates the exact contamination that already happened once (2026-08-14, when
 * a Cosmos ai_memory export landed in the NON-personal bucket and had to be moved). So the mapping
 * is an EXPLICIT allow-list, verified against the live bucket layout rather than inferred, and it
 * FAILS CLOSED: an unrecognised (account, container) pair returns null and the caller refuses. A
 * wrong-but-plausible default here would silently serve privileged documents from, or into, the
 * shared ring.
 *
 * Note this module does not make ring DECISIONS. Callers gate on lane before ever reaching a store
 * (isLaneAllowed in search-privileged.ts, the legal ring checks in the legal tools). This mapping's
 * job is narrower and absolute: never let an already-authorised request for one container resolve
 * to another container's physical bucket.
 *
 * NO LONGER READ-ONLY (2026-08-18). The original header said "READ-ONLY BY CONSTRUCTION ... Document
 * writes continue to go to Azure until the mirror becomes primary, which is a later, separate step."
 * That step has now happened, involuntarily: Azure subscription 55c84f6b is permanently gone, so
 * "writes continue to go to Azure" no longer means "writes go to the source of truth", it means
 * "writes fail". The S3 side is not a mirror of a live Azure any more; for the rooms mapped below it
 * IS the source of truth, and the divergence risk the old paragraph guarded against cannot occur
 * because there is nothing left to diverge FROM.
 *
 * The write verbs are therefore additive and deliberately narrow: putObjectToS3 / copyObjectInS3 /
 * deleteObjectFromS3, all going through the SAME s3LocationFor allow-list as the reads, so a write
 * inherits the identical fail-closed ring mapping. Which CALLERS are allowed to write which
 * container remains the caller's decision (see blob-store.ts: personal legal writes are still
 * refused here on purpose -- the personal DR bucket's IAM grant is GetObject/ListBucket only, see
 * infra/aws/iam.tf's PersonalLegalRingReadOnly statement, and widening it is a ring decision nobody
 * has made).
 */
import { loadEnv } from '../config/env.js';
import { createHash } from 'node:crypto';
import { resolveAwsCredentials, signRequest, canonicalUri, type AwsCredentials } from '../search/sigv4.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

/** SHA-256 of the empty string: the required `x-amz-content-sha256` for any bodyless S3 request. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface S3Location {
  bucket: string;
  /** Key prefix inside the bucket. Mirror keys are `<azureAccount>/<container>/<blobPath>`. */
  keyPrefix: string;
}

/**
 * The (storage account, container) -> (bucket, prefix) allow-list.
 *
 * Verified 2026-08-15 against the live mirror by listing each bucket's real prefixes, NOT assumed
 * from naming. Keep this table and the buckets in lockstep; adding a room without adding a row
 * makes that room unreadable (loud), which is the correct failure direction. Adding a row pointing
 * at the wrong bucket makes it readable from the wrong ring (silent), which is why rows are never
 * added speculatively.
 */
const MIRROR: Readonly<Record<string, S3Location>> = Object.freeze({
  // PRIVILEGED. Its own bucket, and nothing else may resolve there.
  'otchealthlegalstore/personal': {
    bucket: 'otchealth-legal-personal-dr-55c84f6b',
    keyPrefix: 'otchealthlegalstore/personal/',
  },
  'otchealthlegalstore/company': {
    bucket: 'otchealth-finance-legal-dr-55c84f6b',
    keyPrefix: 'otchealthlegalstore/company/',
  },
  'otchealthlegalstore/exec': {
    bucket: 'otchealth-finance-legal-dr-55c84f6b',
    keyPrefix: 'otchealthlegalstore/exec/',
  },
  'otchealthcfodata/cfo-source-docs': {
    bucket: 'otchealth-finance-legal-dr-55c84f6b',
    keyPrefix: 'otchealthcfodata/cfo-source-docs/',
  },
  'otchealthcfodata/cro-from-the-chair': {
    bucket: 'otchealth-finance-legal-dr-55c84f6b',
    keyPrefix: 'otchealthcfodata/cro-from-the-chair/',
  },
  'otchealthcfodata/innd-stock': {
    bucket: 'otchealth-finance-legal-dr-55c84f6b',
    keyPrefix: 'otchealthcfodata/innd-stock/',
  },
  /**
   * The cross-agent SHARED BRAIN (src/memory/store.ts's commons feed: `_MEMORY/_exec/<agent>.jsonl`).
   * Added 2026-08-18 because its ABSENCE was the bug: with no row here, `memory_remember` had nowhere
   * to write once Azure went dark, and it threw `commons put 403` BEFORE the OpenSearch index step,
   * so every memory write since was lost outright rather than merely unindexed.
   *
   * Bucket choice is not a new grant: the ECS task role already holds s3:PutObject on
   * otchealth-finance-legal-dr-55c84f6b (infra/aws/iam.tf, the runtime-access statement lists
   * GetObject + PutObject + ListBucket on that bucket and its /*), so this row needs zero IAM or
   * Terraform change. It is emphatically NOT the personal-legal bucket -- that one is read-only by
   * IAM and privileged by ring.
   */
  'otchealthcommons/company-journal': {
    bucket: 'otchealth-finance-legal-dr-55c84f6b',
    keyPrefix: 'otchealthcommons/company-journal/',
  },
});

/** The bucket holding attorney-privileged personal legal. Exported so tests can assert that nothing
 *  else in the table resolves to it, and that personal never resolves anywhere else. */
export const PERSONAL_LEGAL_BUCKET = 'otchealth-legal-personal-dr-55c84f6b';

/**
 * Resolve a storage account + container to its mirror location. Returns null for anything not
 * explicitly listed — callers MUST treat null as "refuse", never as "use a default".
 */
export function s3LocationFor(account: string, container: string): S3Location | null {
  const key = `${(account || '').trim()}/${(container || '').trim()}`;
  return MIRROR[key] ?? null;
}

/** True when reads should be served from the S3 mirror rather than Azure Blob. */
export function s3BlobBackendActive(): boolean {
  return loadEnv().BLOB_BACKEND === 's3';
}

/** Whether S3 reads are actually usable (endpoint region + resolvable credentials). */
export async function s3BlobConfigured(): Promise<boolean> {
  return (await resolveAwsCredentials()) !== null;
}

/**
 * Fetch one mirrored blob. Mirrors `fetchBlobRaw`'s contract exactly — `{found:false}` on a missing
 * object, throw on any other failure — so it is a drop-in for the Azure path and a 404 never gets
 * confused with an auth or network failure.
 */
export async function fetchBlobFromS3(
  account: string,
  container: string,
  path: string,
): Promise<{ found: boolean; contentType: string | null; buf: Buffer | null }> {
  const loc = s3LocationFor(account, container);
  if (!loc) {
    // Fail closed and say exactly why. Serving this from a guessed bucket is how a privileged
    // document ends up answering a shared-ring request.
    throw new Error(`no S3 mirror mapping for ${account}/${container} (refusing to guess a bucket)`);
  }
  const credentials = await resolveAwsCredentials();
  if (!credentials) throw new Error('S3 credentials unavailable');

  const e = loadEnv();
  // Same region as the rest of the AWS estate. OPENSEARCH_REGION is the one region setting this
  // schema already carries, and the mirror buckets sit alongside the OpenSearch domain, so reusing
  // it keeps a single knob rather than introducing a second one that can silently disagree.
  const region = e.OPENSEARCH_REGION || 'us-east-1';
  const host = `${loc.bucket}.s3.${region}.amazonaws.com`;
  const objectKey = `${loc.keyPrefix}${path}`;

  // ENCODE EXACTLY ONCE, AND ONLY VIA canonicalUri (2026-08-17 fix for a silent read failure).
  //
  // signRequest canonicalizes the path it is given -- it calls canonicalUri() internally. The
  // previous code ALSO pre-encoded with encodeURIComponent and passed the result in, so a space
  // became `%20` on the wire but `%2520` inside the signed canonical request. Signature mismatch,
  // S3 answered 403, and the 403 branch below reported `found:false`. Every object key containing a
  // space was therefore silently unreadable while reporting as ABSENT -- which is how ~11 finance
  // documents were written up as a "data coverage gap" when they were present the whole time.
  // Keys with no character needing encoding were unaffected (double-encoding a no-op is a no-op),
  // which is exactly why it hid for so long.
  //
  // encodeURIComponent was ALSO the wrong encoder here even once: it leaves `!*'()` unescaped,
  // while AWS's canonical form requires them percent-encoded. Real filenames in this store contain
  // parentheses (e.g. "... (002) ..."), so that divergence was a second latent failure.
  //
  // Signing the RAW path and sending canonicalUri(raw) makes both sides use one encoder by
  // construction, so they cannot drift apart again.
  //
  // ⚠ DO NOT COPY THIS PATTERN ONTO THE OpenSearch CALL SITES. It is correct HERE only because S3
  // is AWS's one exception: "Each path segment must be URI-encoded twice (except for Amazon S3,
  // which only gets URI-encoded once)." The 'es' sites in src/search/ deliberately pre-encode and
  // then let canonicalUri encode again, which is the required DOUBLE pass for a non-S3 service --
  // see the worked example in src/search/sigv4.test.ts. "Fixing" them to match this file would
  // under-encode and break OpenSearch signing, i.e. the same class of failure in the opposite
  // direction.
  const rawPath = `/${objectKey}`;
  const wirePath = canonicalUri(rawPath);

  const signed = signRequest({
    method: 'GET',
    host,
    path: rawPath,
    region,
    service: 's3',
    credentials,
    // S3 rejects a request without this header (400 InvalidRequest), and it must be SIGNED.
    extraHeaders: { 'x-amz-content-sha256': EMPTY_SHA256 },
  });
  const r = await fetchWithBudget(`https://${host}${wirePath}`, { method: 'GET', headers: signed.headers });
  if (r.status === 404 || r.status === 403) {
    // S3 answers 403 rather than 404 for a missing key when the caller lacks ListBucket, so both
    // mean "not there" for our purposes. Treating 403 as a hard error would turn an absent document
    // into an exception and break the caller's found:false path.
    return { found: false, contentType: null, buf: null };
  }
  if (!r.ok) throw new Error(`s3 blob get ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return {
    found: true,
    contentType: r.headers.get('content-type'),
    buf: Buffer.from(await r.arrayBuffer()),
  };
}

/**
 * LIST objects under a prefix, from the mirror.
 *
 * WHY THIS EXISTS (2026-08-17): `BLOB_BACKEND=s3` was honoured in exactly ONE place -- the raw byte
 * fetch. Every other legal document operation went straight to Azure regardless, so the CLO's
 * `legal_blob_list` / `legal_blob_get` surface stayed hard-bound to Azure while the CFO's finance
 * document reads had already moved. If Azure went dark, legal documents stopped and finance
 * documents kept working, and no preflight caught it because the preflight only ever exercised the
 * finance path.
 *
 * Returns keys RELATIVE to the mirror prefix, so the shape matches Azure's listing exactly and
 * callers need no branch. Read-only, like the rest of this module.
 */
export async function listBlobsFromS3(
  account: string,
  container: string,
  prefix?: string,
): Promise<Array<{ name: string; size: number | null; lastModified: string | null; etag: string | null }>> {
  const loc = s3LocationFor(account, container);
  if (!loc) throw new Error(`no S3 mirror mapping for ${account}/${container} (refusing to guess a bucket)`);
  const credentials = await resolveAwsCredentials();
  if (!credentials) throw new Error('S3 credentials unavailable');

  const region = loadEnv().OPENSEARCH_REGION || 'us-east-1';
  const host = `${loc.bucket}.s3.${region}.amazonaws.com`;
  const out: Array<{ name: string; size: number | null; lastModified: string | null; etag: string | null }> = [];
  let token: string | null = null;

  // Bounded like the Azure listing it replaces (200 pages x 1000 keys). A prefix that would exceed
  // that is a caller error, not something to silently truncate.
  for (let page = 0; page < 200; page++) {
    const query: Record<string, string> = {
      'list-type': '2',
      'max-keys': '1000',
      prefix: `${loc.keyPrefix}${prefix ?? ''}`,
    };
    if (token) query['continuation-token'] = token;
    // signRequest canonicalises the query itself; pass it raw, exactly as the path is passed raw.
    const signed = signRequest({
      method: 'GET',
      host,
      path: '/',
      query,
      region,
      service: 's3',
      credentials,
      extraHeaders: { 'x-amz-content-sha256': EMPTY_SHA256 },
    });
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join('&');
    const r = await fetchWithBudget(`https://${host}/?${qs}`, { method: 'GET', headers: signed.headers });
    if (r.status === 404) break;
    // NOT folded into "empty": a 403 here is a credential or signature failure, and reporting it as
    // an empty container is exactly the false-absence bug this store already shipped once.
    if (!r.ok) throw new Error(`s3 blob list ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const xml = await r.text();
    for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const b = block[1];
      const key = (b.match(/<Key>([^<]*)<\/Key>/) || [])[1];
      if (!key) continue;
      const size = (b.match(/<Size>(\d+)<\/Size>/) || [])[1];
      const lm = (b.match(/<LastModified>([^<]*)<\/LastModified>/) || [])[1];
      const etag = (b.match(/<ETag>([^<]*)<\/ETag>/) || [])[1];
      out.push({
        // Strip the mirror prefix so the name matches what Azure would have returned.
        name: unescapeXml(key.startsWith(loc.keyPrefix) ? key.slice(loc.keyPrefix.length) : key),
        size: size ? Number.parseInt(size, 10) : null,
        lastModified: lm ?? null,
        etag: etag ? unescapeXml(etag) : null,
      });
    }
    token = (xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/) || [])[1] || null;
    if (!token) break;
  }
  return out;
}

/** S3 object keys are XML-escaped in a ListObjectsV2 body; real filenames here contain `&`. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ══════════════════════════ WRITE PATH (2026-08-18) ══════════════════════════
//
// Everything below writes. It shares ONE request helper with a single, non-optional encoding rule,
// so the 2026-08-17 double-encoding bug documented at length inside fetchBlobFromS3 cannot be
// reintroduced by a new verb: `s3ObjectRequest` is the only place a key becomes a URL, it signs the
// RAW path and sends canonicalUri(raw), and no caller below ever touches an encoder itself.
//
// ⚠ THE RULE, RESTATED SO IT IS NOT RE-DERIVED WRONG: S3 percent-encodes each path segment EXACTLY
// ONCE. Every other AWS service encodes TWICE. A double-encoded key produces a signature mismatch
// that S3 reports as HTTP 403 -- indistinguishable, at a glance, from a permissions problem, which
// is precisely why the read-side instance of this bug survived long enough to be written up as a
// "data coverage gap". Do NOT pre-encode with encodeURIComponent before calling in here, and do NOT
// copy this single-encode pattern onto the OpenSearch ('es') call sites in src/search/.

/** Everything a signed S3 object-level request needs. `path` is the RAW (unencoded) object key. */
interface S3ObjectRequestOpts {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  loc: S3Location;
  /** Object key RELATIVE to loc.keyPrefix, raw and unencoded. */
  path: string;
  credentials: AwsCredentials;
  region: string;
  /** Raw request bytes. Its SHA-256 becomes the signed x-amz-content-sha256 / payload hash. */
  body?: Buffer;
  contentType?: string;
  /** Extra headers to SIGN and send (x-amz-*, if-none-match, if-match, ...). */
  extraHeaders?: Record<string, string>;
}

/**
 * Sign and issue one object-level S3 request. The single choke point for key encoding.
 *
 * The payload hash is computed from the ACTUAL bytes: S3 requires x-amz-content-sha256 to be present
 * AND signed, and it must equal the canonical request's payload hash or the signature fails. Passing
 * the Buffer straight to signRequest keeps both derived from one value, so they cannot disagree.
 */
async function s3ObjectRequest(opts: S3ObjectRequestOpts): Promise<Response> {
  const host = `${opts.loc.bucket}.s3.${opts.region}.amazonaws.com`;
  const rawPath = `/${opts.loc.keyPrefix}${opts.path}`;
  const body = opts.body;
  const payloadHash = body ? createHash('sha256').update(body).digest('hex') : EMPTY_SHA256;

  const extraHeaders: Record<string, string> = {
    'x-amz-content-sha256': payloadHash,
    ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
    ...opts.extraHeaders,
  };

  const signed = signRequest({
    method: opts.method,
    host,
    path: rawPath,
    region: opts.region,
    service: 's3',
    credentials: opts.credentials,
    ...(body ? { body } : {}),
    extraHeaders,
  });

  return fetchWithBudget(`https://${host}${canonicalUri(rawPath)}`, {
    method: opts.method,
    headers: signed.headers,
    // A Node Buffer is a Uint8Array, which fetch accepts as a body; the cast only satisfies the DOM
    // BodyInit typing this tsconfig's lib does not expose.
    ...(body ? { body: body as unknown as RequestInit['body'] } : {}),
    // fetchWithBudget retries once on a network error / 429 / 5xx. Safe here: every write is
    // idempotent by construction -- a PUT of a fixed body to a fixed key, a DELETE of a key, a copy
    // of a pinned source version -- so none of them accumulate an effect when repeated. The one
    // wrinkle worth naming: if a create-only write (If-None-Match: *) actually lands and THEN the
    // response is lost to a 5xx, the retry sees 412 and surfaces as "already exists". Misleading
    // wording, but it fails safe -- nothing is overwritten and nothing is silently reported as
    // written that was not.
  });
}

/** Resolve (mapping, credentials, region) or THROW. Shared preamble for every write verb, so a
 *  missing mapping fails closed identically on the write side as on the read side. */
async function writeContext(
  account: string,
  container: string,
): Promise<{ loc: S3Location; credentials: AwsCredentials; region: string }> {
  const loc = s3LocationFor(account, container);
  if (!loc) throw new Error(`no S3 mirror mapping for ${account}/${container} (refusing to guess a bucket)`);
  const credentials = await resolveAwsCredentials();
  if (!credentials) throw new Error('S3 credentials unavailable');
  return { loc, credentials, region: loadEnv().OPENSEARCH_REGION || 'us-east-1' };
}

/**
 * PUT one object.
 *
 * `overwrite=false` sends `If-None-Match: *` (S3 conditional writes), so a concurrent create between
 * a caller's existence check and this PUT is refused server-side with 412 rather than silently
 * clobbering. That mirrors the Azure putBlob guard exactly.
 *
 * FAILS LOUD on every non-2xx. There is deliberately no "treat 403 as absent" branch on the write
 * side: the reads conflate 404/403 because S3 answers 403 for a missing key when the caller lacks
 * ListBucket, but a 403 on a WRITE is never "the object is not there", it is "the write did not
 * happen", and reporting that as success is the precise failure this whole change exists to end.
 */
export async function putObjectToS3(
  account: string,
  container: string,
  path: string,
  body: Buffer,
  contentType: string,
  // FAIL-CLOSED DEFAULT, matching putBlob's. A raw primitive that clobbers unless told otherwise is
  // the wrong default for a store holding filed legal documents; every real call site passes this
  // explicitly anyway (blob-store.ts forwards the caller's choice, the commons feed passes true
  // because rewriting the JSONL file IS the append).
  overwrite = false,
): Promise<{ bytes: number; etag: string | null }> {
  const ctx = await writeContext(account, container);
  const r = await s3ObjectRequest({
    method: 'PUT',
    loc: ctx.loc,
    path,
    credentials: ctx.credentials,
    region: ctx.region,
    body,
    contentType,
    ...(overwrite ? {} : { extraHeaders: { 'if-none-match': '*' } }),
  });
  if (r.status === 409 || r.status === 412) {
    throw new Error(
      `s3 blob put refused: an object already exists at ${container}/${path} (HTTP ${r.status}). ` +
        `Pass overwrite=true to intentionally replace it.`,
    );
  }
  if (!r.ok) throw new Error(`s3 blob put ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return { bytes: body.length, etag: r.headers.get('etag') };
}

/**
 * Server-side COPY within one bucket (S3 CopyObject: a PUT on the destination carrying
 * `x-amz-copy-source`).
 *
 * `sourceEtag` pins the copy to the exact version the caller observed, via
 * `x-amz-copy-source-if-match` -- the direct S3 equivalent of Azure's `x-ms-source-if-match`, and
 * the same TOCTOU guard the copy-then-delete callers depend on.
 *
 * ⚠ S3 CopyObject CAN RETURN HTTP 200 WITH AN ERROR IN THE BODY. A long copy that fails midway
 * answers 200 and puts `<Error>` in the payload; trusting the status code alone reports a failed
 * copy as a success, and a copy-then-delete caller would then delete the original. So the body is
 * parsed and a missing `<ETag>` (or a present `<Error>`) is treated as a failure.
 */
export async function copyObjectInS3(
  account: string,
  container: string,
  srcPath: string,
  dstPath: string,
  opts: { overwrite?: boolean; sourceEtag?: string } = {},
): Promise<{ bytes: number; etag: string | null }> {
  const ctx = await writeContext(account, container);
  // The copy-source header value is a /<bucket>/<key> reference and must be percent-encoded the same
  // single way as a path -- canonicalUri is the same encoder used for the request line, so the two
  // cannot drift apart.
  const copySource = canonicalUri(`/${ctx.loc.bucket}/${ctx.loc.keyPrefix}${srcPath}`);
  const extraHeaders: Record<string, string> = { 'x-amz-copy-source': copySource };
  if (opts.sourceEtag) extraHeaders['x-amz-copy-source-if-match'] = opts.sourceEtag;
  if (!opts.overwrite) extraHeaders['if-none-match'] = '*';

  const r = await s3ObjectRequest({
    method: 'PUT',
    loc: ctx.loc,
    path: dstPath,
    credentials: ctx.credentials,
    region: ctx.region,
    extraHeaders,
  });
  if (r.status === 404) throw new Error(`s3 blob copy: source ${container}/${srcPath} not found.`);
  if (r.status === 409 || r.status === 412) {
    throw new Error(
      `s3 blob copy refused (HTTP ${r.status}): either an object already exists at ${container}/${dstPath} ` +
        `(pass overwrite=true to replace it), or the source at ${container}/${srcPath} changed since it was ` +
        `last checked and no longer matches the expected version. Re-check and retry.`,
    );
  }
  if (!r.ok) throw new Error(`s3 blob copy ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const xml = await r.text();
  if (/<Error>/.test(xml) || !/<ETag>/.test(xml)) {
    throw new Error(
      `s3 blob copy returned HTTP 200 with a failed CopyObjectResult for ${container}/${dstPath} ` +
        `(S3 reports a mid-copy failure in the body, not the status): ${xml.slice(0, 200)}`,
    );
  }
  const etag = (xml.match(/<ETag>([^<]*)<\/ETag>/) || [])[1] ?? null;
  // CopyObjectResult carries no size, and the PUT response's Content-Length is the response body's
  // length, not the object's. A HEAD on the destination is the only honest source of real bytes --
  // the same reason the Azure copyBlob ends with a HEAD.
  const head = await headBlobFromS3(account, container, dstPath);
  return { bytes: head.size ?? 0, etag: etag ? unescapeXml(etag) : null };
}

/**
 * Thrown when an ETag-pinned blob mutation is REFUSED by the store because the object no longer
 * matches the expected version. S3 and Azure both answer 412 Precondition Failed, so both backends
 * throw this one type and a caller can branch on it without sniffing message text.
 *
 * A DISTINCT TYPE, not a bare Error, because a copy-then-delete caller must tell three outcomes
 * apart that a bare throw collapses: (a) the object is already gone -- nothing to do, the operation
 * succeeded; (b) the object is THERE but CHANGED under us, so the delete was correctly refused and
 * the caller must not claim it happened; (c) the store said no for some other reason (403, 5xx).
 * Folding (b) or (c) into (a) is precisely the silent-success defect this file used to have.
 */
export class BlobPreconditionFailedError extends Error {
  readonly container: string;
  readonly path: string;
  readonly expectedEtag: string;
  constructor(container: string, path: string, expectedEtag: string) {
    super(
      `blob delete refused (HTTP 412 Precondition Failed): the object at ${container}/${path} ` +
        `changed since it was copied (it no longer matches the expected ETag ${expectedEtag}). ` +
        `Nothing was deleted; investigate and retry.`,
    );
    this.name = 'BlobPreconditionFailedError';
    this.container = container;
    this.path = path;
    this.expectedEtag = expectedEtag;
  }
}

/**
 * DELETE one object. Idempotent: S3 answers 204 whether or not the key existed, so "already gone"
 * is success, matching the Azure primitive's 404 handling.
 *
 * `ifMatch` IS A REAL SERVER-SIDE PRECONDITION, sent on the DELETE itself. S3 DeleteObject accepts
 * the standard `If-Match` header on general purpose buckets and answers 412 when the ETag does not
 * match; only `x-amz-if-match-last-modified-time` and `x-amz-if-match-size` are directory-bucket
 * only (AWS S3 API reference, DeleteObject: "The If-Match header is supported for both general
 * purpose and directory buckets").
 *
 * AN EARLIER VERSION ASSERTED THE OPPOSITE -- that S3 had no If-Match equivalent -- and implemented
 * the guard as HEAD-then-DELETE. That rationale was factually wrong, and the implementation it
 * justified was worse than the gap it claimed to be honest about, in two compounding ways:
 *   1. TOCTOU. A write landing between the HEAD and the DELETE was not caught, so the "guard" could
 *      delete a version it had never verified.
 *   2. SILENT SUCCESS, the serious one. `headBlobFromS3` deliberately folds BOTH 404 and 403 into
 *      `exists:false` -- correct for a document READ, where S3 answers 403 for a missing key when
 *      the caller lacks ListBucket -- so on a 403 the guarded path took the `already gone` branch
 *      and RETURNED SUCCESS having issued ZERO DELETE requests. The blast radius was the primary
 *      paths, not a corner case: legal_blob_move reported a COMPLETE move with the source document
 *      still live at the old path, and legal_blob_delete returned executed:true and wrote an AUDIT
 *      RECORD asserting a mutation that never happened -- on attorney-privileged, MNPI-adjacent
 *      data.
 * Sending the condition with the delete is strictly stronger than both: the server decides, no HEAD
 * is involved so there is no window and no 403 to swallow, and a refusal is a loud typed 412.
 */
export async function deleteObjectFromS3(
  account: string,
  container: string,
  path: string,
  ifMatch?: string,
): Promise<void> {
  const ctx = await writeContext(account, container);
  const r = await s3ObjectRequest({
    method: 'DELETE',
    loc: ctx.loc,
    path,
    credentials: ctx.credentials,
    region: ctx.region,
    // Lowercase deliberately: signRequest sorts and canonicalises by the literal key it is handed,
    // so a signed header must already be lowercase or the signature will not match the wire.
    ...(ifMatch ? { extraHeaders: { 'if-match': ifMatch } } : {}),
  });
  // BEFORE the generic !r.ok below, and before the 404 idempotency branch: a refused precondition is
  // neither a transport failure nor "already gone", and must never be reported as either.
  if (r.status === 412) throw new BlobPreconditionFailedError(container, path, ifMatch ?? '');
  if (r.status === 404) return; // idempotent
  if (!r.ok) throw new Error(`s3 blob delete ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/**
 * GET one object as TEXT, with the loud-failure contract the memory commons feed requires.
 *
 * Deliberately NOT a wrapper over fetchBlobFromS3. That function folds 403 into `found:false`, which
 * is right for a legal DOCUMENT read (S3 answers 403 for a missing key when the caller lacks
 * ListBucket) and WRONG here: the commons feed's readers -- memory_team, wake, memory_recall,
 * memory_pack, entity-lookup and the RETRACTION filter -- read "no rows" as "nobody recorded
 * anything", so a 403 folded into an empty feed resurfaces retracted beliefs as current truth. That
 * exact false-empty was already fixed once on the Azure listing path (see listShared in
 * src/memory/store.ts); this keeps the S3 path held to the identical standard.
 *
 * 404 -> null (the blob genuinely does not exist yet: a lane's first write). Anything else THROWS.
 */
export async function getTextFromS3(account: string, container: string, path: string): Promise<string | null> {
  const ctx = await writeContext(account, container);
  const r = await s3ObjectRequest({
    method: 'GET',
    loc: ctx.loc,
    path,
    credentials: ctx.credentials,
    region: ctx.region,
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(
      `s3 commons get ${r.status} (refusing to report a missing feed as empty): ${(await r.text()).slice(0, 160)}`,
    );
  }
  return await r.text();
}

/** HEAD one mirrored object: existence + ETag + size, without downloading it. */
export async function headBlobFromS3(
  account: string,
  container: string,
  path: string,
): Promise<{ exists: boolean; etag: string | null; size: number | null }> {
  const loc = s3LocationFor(account, container);
  if (!loc) throw new Error(`no S3 mirror mapping for ${account}/${container} (refusing to guess a bucket)`);
  const credentials = await resolveAwsCredentials();
  if (!credentials) throw new Error('S3 credentials unavailable');

  const region = loadEnv().OPENSEARCH_REGION || 'us-east-1';
  const host = `${loc.bucket}.s3.${region}.amazonaws.com`;
  // Same single-encode discipline as fetchBlobFromS3: sign the RAW path, send canonicalUri(raw).
  const rawPath = `/${loc.keyPrefix}${path}`;
  const signed = signRequest({
    method: 'HEAD',
    host,
    path: rawPath,
    region,
    service: 's3',
    credentials,
    extraHeaders: { 'x-amz-content-sha256': EMPTY_SHA256 },
  });
  const r = await fetchWithBudget(`https://${host}${canonicalUri(rawPath)}`, {
    method: 'HEAD',
    headers: signed.headers,
  });
  if (r.status === 404 || r.status === 403) return { exists: false, etag: null, size: null };
  if (!r.ok) throw new Error(`s3 blob head ${r.status}`);
  const cl = r.headers.get('content-length');
  return { exists: true, etag: r.headers.get('etag'), size: cl ? Number.parseInt(cl, 10) : null };
}

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

/**
 * A PutObject conditional-write precondition was refused (HTTP 409 or 412): either an
 * If-None-Match:* create collided with an object that already exists, or an If-Match:<etag> update
 * collided with an object that has since changed. Both are "someone else won the race", which a
 * caller may legitimately re-read-and-retry -- unlike every other write failure, which must not be
 * retried blindly. A distinct class (rather than string-matching the message) is what lets a caller
 * distinguish "retry me" from "something is actually broken" without parsing prose.
 */
export class S3ConditionalWriteFailedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'S3ConditionalWriteFailedError';
    this.status = status;
  }
}

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
   * THE BUCKET IS otchealth-brain-dr-55c84f6b, AND THAT IS AN OBSERVED FACT, NOT AN INFERENCE.
   * A read-only listing of the live estate (2026-08-18) found the real shared exec brain already
   * sitting at `otchealth-brain-dr-55c84f6b/otchealthcommons/company-journal/_MEMORY/_exec/*.jsonl`:
   * 29 lane files, every one of them the latest version, zero delete markers -- cto.jsonl 1,236,579
   * bytes, cfo.jsonl 1,956,515, clo.jsonl 932,806, developer.jsonl 896,103, cro.jsonl 623,446,
   * coo.jsonl 194,935, and ~23 more. That is where months of fleet memory physically live. The
   * keyPrefix below is that same listing's prefix verbatim, which is why only the BUCKET field of
   * this row ever needed to change.
   *
   * WHAT THE FIRST VERSION OF THIS ROW GOT WRONG, written down so it is not repeated. It pointed at
   * otchealth-finance-legal-dr-55c84f6b, justified by "the ECS task role already holds s3:PutObject
   * on it". That reasoning cannot work, and the shape of the grant is exactly why: ONE statement in
   * infra/aws/iam.tf's runtime-access policy lists GetObject + PutObject + ListBucket against
   * brain_dr AND finance_legal_dr TOGETHER, in both bare-ARN and `/*` forms. A grant that covers two
   * buckets identically is incapable of discriminating between them. IAM can only ever tell you a
   * write is PERMITTED; it can never tell you WHERE the data is. Only a listing of the real objects
   * answers that, and no listing had been done. The consequence was live: the gateway read the
   * finance-legal path, got 404, treated that as an empty feed, and wrote a NEW 725-byte
   * single-entry cto.jsonl there at 02:35:34Z -- after which memory_team reported
   * shared_entry_count=1 where months of history belong. Nothing was destroyed (both buckets are
   * versioned; the stray key has exactly one version and the brain-dr files were never touched), but
   * the shared brain read as empty to every agent. Pick the bucket from observed object layout; use
   * IAM only to confirm the access you need is already granted.
   *
   * IAM still needs no change for this fix: that same statement covers brain_dr for get/put/list on
   * both ARN shapes, and src/memory/store.ts only ever does get/put/list (no delete, no copy, and a
   * single non-multipart PUT). It remains emphatically NOT the personal-legal bucket -- that one is
   * GetObject/ListBucket only (iam.tf's PersonalLegalRingReadOnly statement) and privileged by ring.
   */
  'otchealthcommons/company-journal': {
    bucket: 'otchealth-brain-dr-55c84f6b',
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
  // CONDITIONAL UPDATE (2026-08-18). When set, sends `If-Match: <ifMatch>` (S3 conditional writes,
  // GA'd August 2024, requires SigV4 -- already the only auth this module speaks) instead of the
  // If-None-Match:* create-guard. This is what lets a read-modify-write caller (appendShared, the
  // shared multi-replica ledger) pin its PUT to the exact version it read: a concurrent writer's PUT
  // in between changes the ETag, so this one gets refused (412/409) instead of silently winning a
  // last-write-wins race and erasing the other writer's entry. `overwrite` is IGNORED when `ifMatch`
  // is set -- the two preconditions are mutually exclusive by construction (an object cannot be
  // simultaneously "must not exist" and "must match this ETag"), and If-Match unambiguously implies
  // the caller believes the object already exists.
  ifMatch?: string,
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
    ...(ifMatch
      ? { extraHeaders: { 'if-match': ifMatch } }
      : overwrite
        ? {}
        : { extraHeaders: { 'if-none-match': '*' } }),
  });
  if (r.status === 409 || r.status === 412) {
    if (ifMatch) {
      throw new S3ConditionalWriteFailedError(
        `s3 blob put refused: the object at ${container}/${path} changed since it was read ` +
          `(expected ETag ${ifMatch}, HTTP ${r.status}). Re-read the object and retry with its current ETag.`,
        r.status,
      );
    }
    throw new S3ConditionalWriteFailedError(
      `s3 blob put refused: an object already exists at ${container}/${path} (HTTP ${r.status}). ` +
        `Pass overwrite=true to intentionally replace it.`,
      r.status,
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
 * DELETE one object. Idempotent: S3 answers 204 whether or not the key existed, so "already gone"
 * is success, matching the Azure primitive's 404 handling.
 *
 * `ifMatch` NOTE, AND ITS LIMIT, STATED PLAINLY: S3 DeleteObject has no universally available
 * If-Match precondition equivalent to Azure Blob's. Rather than send a header S3 may ignore -- which
 * would report an UNGUARDED delete as a guarded one, the worst possible outcome for a
 * copy-then-delete caller -- this verifies the ETag with a HEAD first and refuses on a mismatch.
 * That is strictly weaker than a server-side precondition: a write landing between the HEAD and the
 * DELETE is not caught. It is strictly stronger than ignoring the argument, and it is honest about
 * which of the two it is.
 */
export async function deleteObjectFromS3(
  account: string,
  container: string,
  path: string,
  ifMatch?: string,
): Promise<void> {
  const ctx = await writeContext(account, container);
  if (ifMatch) {
    const head = await headBlobFromS3(account, container, path);
    if (!head.exists) return; // already gone; nothing to guard, nothing to delete
    if (head.etag !== ifMatch) {
      throw new Error(
        `s3 blob delete refused: the object at ${container}/${path} changed since it was copied ` +
          `(ETag ${head.etag} no longer matches the expected ${ifMatch}). Nothing was deleted; investigate and retry.`,
      );
    }
  }
  const r = await s3ObjectRequest({
    method: 'DELETE',
    loc: ctx.loc,
    path,
    credentials: ctx.credentials,
    region: ctx.region,
  });
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
  return (await getTextWithEtagFromS3(account, container, path)).text;
}

/**
 * Same contract as `getTextFromS3`, plus the object's current ETag (null when the object does not
 * exist -- there is nothing to pin a subsequent conditional PUT to). This is the read half of the
 * read-modify-write conditional-update pattern: a caller captures the ETag here and passes it back
 * as `ifMatch` to `putObjectToS3`, so the write is refused (not silently accepted) if anything else
 * changed the object in between.
 */
export async function getTextWithEtagFromS3(
  account: string,
  container: string,
  path: string,
): Promise<{ text: string | null; etag: string | null }> {
  const ctx = await writeContext(account, container);
  const r = await s3ObjectRequest({
    method: 'GET',
    loc: ctx.loc,
    path,
    credentials: ctx.credentials,
    region: ctx.region,
  });
  if (r.status === 404) return { text: null, etag: null };
  if (!r.ok) {
    throw new Error(
      `s3 commons get ${r.status} (refusing to report a missing feed as empty): ${(await r.text()).slice(0, 160)}`,
    );
  }
  return { text: await r.text(), etag: r.headers.get('etag') };
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

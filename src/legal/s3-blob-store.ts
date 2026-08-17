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
 * READ-ONLY BY CONSTRUCTION. No put/delete verb exists here. The S3 side is a mirror; writing to it
 * directly would silently diverge it from the source of truth with no reconciliation path. Document
 * writes continue to go to Azure until the mirror becomes primary, which is a later, separate step.
 */
import { loadEnv } from '../config/env.js';
import { resolveAwsCredentials, signRequest, canonicalUri } from '../search/sigv4.js';
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

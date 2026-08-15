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
import { resolveAwsCredentials, signRequest } from '../search/sigv4.js';
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
  // Each path segment is encoded individually: object keys legitimately contain '/' as a separator,
  // and encoding it would look for a key with a literal %2F in its name.
  const objectKey = `${loc.keyPrefix}${path}`;
  const signPath = '/' + objectKey.split('/').map(encodeURIComponent).join('/');

  const signed = signRequest({
    method: 'GET',
    host,
    path: signPath,
    region,
    service: 's3',
    credentials,
    // S3 rejects a request without this header (400 InvalidRequest), and it must be SIGNED.
    extraHeaders: { 'x-amz-content-sha256': EMPTY_SHA256 },
  });
  const r = await fetchWithBudget(`https://${host}${signPath}`, { method: 'GET', headers: signed.headers });
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

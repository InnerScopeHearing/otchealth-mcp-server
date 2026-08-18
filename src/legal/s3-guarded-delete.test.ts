import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * REGRESSION: the guarded (ETag-pinned) delete on the S3 legal blob path could report SUCCESS
 * having issued ZERO DELETE requests (2026-08-18).
 *
 * The old deleteObjectFromS3 enforced `ifMatch` with a HEAD pre-check, on the stated belief that
 * "S3 DeleteObject has no If-Match precondition equivalent to Azure Blob's". That belief is FALSE:
 * the AWS S3 API reference for DeleteObject says verbatim "The If-Match header is supported for
 * both general purpose and directory buckets"; only x-amz-if-match-last-modified-time and
 * x-amz-if-match-size are directory-bucket-only.
 *
 * The implementation that wrong belief justified was worse than the gap it claimed to be honest
 * about. headBlobFromS3 folds BOTH 404 and 403 into `exists:false` -- correct for a document READ,
 * where S3 answers 403 for a missing key when the caller lacks ListBucket -- so a 403 on that HEAD
 * took the "already gone, nothing to delete" branch and RESOLVED SUCCESSFULLY without ever sending
 * a DELETE. Downstream, legal_blob_move reported a COMPLETE move with the source document still
 * live at the old path, and legal_blob_delete returned executed:true and wrote an AUDIT RECORD
 * asserting a mutation that never happened -- on attorney-privileged, MNPI-adjacent data.
 *
 * The fix sends the condition ON the DELETE itself and deletes the HEAD pre-check entirely, which
 * is strictly stronger: no TOCTOU window between check and act, and no 403-swallowing HEAD.
 *
 * THE LOAD-BEARING TESTS HERE ASSERT ON THE REQUESTS ACTUALLY ISSUED, not on the return value.
 * A function that returns without throwing is indistinguishable from a correct one until you ask
 * whether it actually talked to S3 -- which is exactly how this defect survived review.
 *
 * Own file: BLOB_BACKEND=s3 must be set before loadEnv() caches.
 */

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.AZURE_LEGAL_STORAGE_ACCOUNT = 'otchealthlegalstore';
process.env.AZURE_LEGAL_STORAGE_KEY = Buffer.from('k'.repeat(32)).toString('base64');
process.env.BLOB_BACKEND = 's3';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

const { deleteBlobHard, BlobPreconditionFailedError } = await import('./blob-store.js');
const { handleLegalBlobMove } = await import('../tools/legal/blob-move.js');

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Records every request the code under test actually issues, and answers it from `handler`. */
async function capture<T>(
  handler: (call: Seen) => Response,
  run: () => Promise<T>,
): Promise<{ error: unknown; value: T | undefined; calls: Seen[] }> {
  const calls: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const call: Seen = {
      url: String(u),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  try {
    const value = await run();
    return { error: undefined, value, calls };
  } catch (error) {
    return { error, value: undefined, calls };
  } finally {
    globalThis.fetch = original;
  }
}

const deletes = (calls: Seen[]) => calls.filter((c) => c.method === 'DELETE');

// ───────────── (a) a 403 must NEVER read as "already gone" ─────────────

test('GUARDED DELETE: a 403 does NOT report success (the HEAD that swallowed 403 is gone)', async () => {
  // Every request is denied. Under the old HEAD-then-delete code the HEAD's 403 became
  // `exists:false` and the function RESOLVED -- reporting a delete that never happened. A denial
  // must surface as a denial.
  const { error, calls } = await capture(
    () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
    () => deleteBlobHard('company', 'cases/brief.pdf', '"v1"'),
  );
  assert.notEqual(error, undefined, 'a 403 must throw, never resolve as "already gone"');
  assert.match(String((error as Error).message), /403/);
  // And it must not be mistaken for the ETag-mismatch case either: 403 is "we were refused",
  // 412 is "the object changed". Different causes, different remedies.
  assert.equal(error instanceof BlobPreconditionFailedError, false);
  assert.equal(deletes(calls).length, 1, 'the refusal must come from the DELETE itself');
});

// ───────────── (b) THE test that would have caught the bug ─────────────

test('GUARDED DELETE: actually issues a DELETE carrying if-match, and issues NO HEAD at all', async () => {
  // Asserting on the REQUEST, not the return value. The old code returned exactly the same
  // "success" as the new code in the scenario below while sending no DELETE whatsoever.
  const { error, calls } = await capture(
    (call) =>
      call.method === 'HEAD'
        ? // The delete-time HEAD is denied. The old code stopped right here and called it done.
          new Response(null, { status: 403 })
        : new Response(null, { status: 204 }),
    () => deleteBlobHard('company', 'cases/brief.pdf', '"v1"'),
  );
  assert.equal(error, undefined, 'the DELETE was accepted (204), so this must resolve');

  const sent = deletes(calls);
  assert.equal(sent.length, 1, 'a guarded delete MUST reach S3 -- this is the whole defect');
  assert.equal(sent[0].headers['if-match'], '"v1"', 'the precondition must travel WITH the delete');
  assert.ok(sent[0].url.includes('cases/brief.pdf'), sent[0].url);

  // No HEAD means no TOCTOU window and no 403 to swallow. The absence is the fix.
  assert.equal(
    calls.some((c) => c.method === 'HEAD'),
    false,
    'no HEAD pre-check may remain: it is the TOCTOU window AND the 403-swallowing path',
  );
});

test('UNGUARDED DELETE: no ifMatch sends no if-match header (backward compatible)', async () => {
  const { error, calls } = await capture(
    () => new Response(null, { status: 204 }),
    () => deleteBlobHard('company', 'cases/brief.pdf'),
  );
  assert.equal(error, undefined);
  assert.equal(deletes(calls).length, 1);
  assert.equal(deletes(calls)[0].headers['if-match'], undefined);
});

// ───────────── (c) 412 is its own outcome ─────────────

test('GUARDED DELETE: a 412 surfaces as BlobPreconditionFailedError, not success and not not-found', async () => {
  const { error, calls } = await capture(
    (call) =>
      call.method === 'HEAD'
        ? // Whatever a HEAD would have said is irrelevant now; the server decides. Answering 200
          // with the MATCHING ETag here proves the refusal comes from the DELETE's own precondition
          // and not from any client-side comparison.
          new Response(null, { status: 200, headers: { etag: '"v1"', 'content-length': '10' } })
        : new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 }),
    () => deleteBlobHard('company', 'cases/brief.pdf', '"v1"'),
  );
  assert.notEqual(error, undefined, 'a refused precondition must never resolve as success');
  assert.ok(
    error instanceof BlobPreconditionFailedError,
    `expected a typed BlobPreconditionFailedError, got ${(error as Error)?.name}: ${(error as Error)?.message}`,
  );
  const e = error as InstanceType<typeof BlobPreconditionFailedError>;
  assert.equal(e.container, 'company');
  assert.equal(e.path, 'cases/brief.pdf');
  assert.equal(e.expectedEtag, '"v1"');
  assert.match(e.message, /changed since it was copied/);
  assert.equal(deletes(calls).length, 1);
});

test('GUARDED DELETE: a 404 stays idempotent success and is NOT a precondition failure', async () => {
  // The distinction (c) is really about: "gone" and "changed under us" must not collapse together.
  const { error } = await capture(
    () => new Response(null, { status: 404 }),
    () => deleteBlobHard('company', 'cases/brief.pdf', '"v1"'),
  );
  assert.equal(error, undefined, 'already-gone remains idempotent success');
});

// ───────────── (d) the move must not claim what it did not do ─────────────

test('legal_blob_move does NOT report a completed move when the source delete never happened', async () => {
  // Sequence: HEAD src (preflight, exists) -> HEAD dst (absent) -> PUT copy -> HEAD dst (size)
  // -> delete src. The delete-time HEAD is denied (403) -- a transient authz failure or a
  // permission change landing after the preflight. Under the old code that 403 read as "already
  // gone", deleteObjectFromS3 resolved WITHOUT sending a DELETE, and the move returned a clean
  // success while the source document was still live at src_path.
  const SRC = 'cases/old.pdf';
  const DST = 'cases/new.pdf';
  let copied = false;
  let headSrcSeen = 0;

  const { error, value, calls } = await capture(
    (call) => {
      const isSrc = call.url.includes(SRC);
      if (call.method === 'HEAD') {
        if (isSrc) {
          // Preflight succeeds; any later HEAD of the source is denied.
          return headSrcSeen++ === 0
            ? new Response(null, { status: 200, headers: { etag: '"v1"', 'content-length': '10' } })
            : new Response(null, { status: 403 });
        }
        return copied
          ? new Response(null, { status: 200, headers: { etag: '"v2"', 'content-length': '10' } })
          : new Response(null, { status: 404 });
      }
      if (call.method === 'PUT') {
        copied = true;
        return new Response('<CopyObjectResult><ETag>&quot;v2&quot;</ETag></CopyObjectResult>', { status: 200 });
      }
      // The DELETE itself is permitted and succeeds -- so the ONLY thing that can make this move
      // legitimate is that the DELETE was actually sent.
      return new Response(null, { status: 204 });
    },
    () =>
      handleLegalBlobMove(
        { container: 'company', src_path: SRC, dst_path: DST },
        { correlationId: 'test-corr', callerHash: 'test-hash', dryRun: false, acknowledgeWarning: false, callerAgent: 'clo' },
      ),
  );

  const srcDeletes = deletes(calls).filter((c) => c.url.includes(SRC));
  const reportedSuccess = error === undefined && !(value as { data?: { error?: string } })?.data?.error;

  // THE INVARIANT: a move may only be reported complete if the source delete actually reached S3.
  // Either the move fails, or a DELETE was sent. Never "success" with zero DELETEs.
  assert.ok(
    !reportedSuccess || srcDeletes.length > 0,
    'legal_blob_move reported a completed move without ever issuing a DELETE for the source',
  );
  assert.equal(srcDeletes.length, 1, 'the source delete must actually be attempted against S3');
  assert.equal(srcDeletes[0].headers['if-match'], '"v1"', 'the move must pin the delete to the version it copied');
});


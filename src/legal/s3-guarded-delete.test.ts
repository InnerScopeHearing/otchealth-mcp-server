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
 * where a 403 is the EXPECTED S3 response for a missing key when the caller lacks ListBucket. HAD
 * that HEAD ever answered 403 for a missing key, the guarded path would have taken the "already
 * gone, nothing to delete" branch and RESOLVED SUCCESSFULLY without ever sending a DELETE, and
 * downstream: legal_blob_move would have reported a COMPLETE move with the source document still
 * live at the old path, and legal_blob_delete would have returned executed:true with an AUDIT
 * RECORD asserting a mutation that never happened -- on attorney-privileged, MNPI-adjacent data.
 * That NAMED TRIGGER -- specifically a missing-key 403 caused by an absent ListBucket grant -- does
 * NOT fire against this repo's own IAM policy: infra/aws/iam.tf grants ListBucket, alongside
 * GetObject, on every one of the three buckets the store touches (the shared `runtime-access`
 * statement for brain_dr + finance_legal_dr, and `PersonalLegalRingReadOnly` for legal_personal_dr),
 * so this was caught and fixed as a LATENT defect, not one observed against production traffic. The
 * swallow stays real and reachable regardless, because the bug was in how ANY 403 on that HEAD got
 * interpreted, not in one specific cause of it: revoked or expired task-role credentials, an
 * explicit IAM/SCP Deny added later, or a future policy edit that narrows ListBucket back off would
 * all reopen the identical hole through a different door.
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

test('GUARDED DELETE: an already-gone object surfaces the SAME 412 refusal as a changed one (real S3 behaviour, not 404)', async () => {
  // This test used to mock a 404 here and assert "already gone" is idempotent success. That was
  // wrong about what S3 actually does: AWS's own conditional-deletes guide documents, for
  // If-Match:*, "If the latest version of the object is a delete marker, the object doesn't exist
  // and the DeleteObject API will fail and return a 412 Precondition Failed response" -- and a
  // real-ETag If-Match is at least as strict (it additionally requires an exact match), so an
  // absent key answers 412 here too, never 404. A guarded delete of an already-gone object and a
  // guarded delete of a genuinely-changed object are therefore INDISTINGUISHABLE over the wire.
  //
  // THE EXPLICIT DECISION (2026-08-18, closing the FIX-FIRST gate on this branch): deleteObjectFromS3
  // does NOT try to tell them apart and does NOT treat this as idempotent success. Both surface as
  // the same typed BlobPreconditionFailedError. Silently folding "gone" into success here would
  // resurrect exactly the defect class this file exists to prevent -- the guard's purpose is "only
  // act if the exact expected state still holds," and a vanished object broke that precondition just
  // as much as a changed one did. A caller that wants "already gone is fine" idempotency on a guarded
  // delete must decide that explicitly (catch the error, re-check current state) -- it is not free.
  const { error, calls } = await capture(
    () => new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 }),
    () => deleteBlobHard('company', 'cases/brief.pdf', '"v1"'),
  );
  assert.ok(
    error instanceof BlobPreconditionFailedError,
    `an already-gone guarded delete must refuse as a typed precondition failure, not resolve; ` +
      `got ${error === undefined ? 'success' : `${(error as Error)?.name}: ${(error as Error)?.message}`}`,
  );
  assert.equal(deletes(calls).length, 1, 'exactly one DELETE attempt, no retry (see retries:0 on the guarded path)');
});

test('GUARDED DELETE: a literal 404 (defensive-only; not the real S3 response for this path) still resolves as idempotent success', async () => {
  // deleteObjectFromS3 keeps an `if (r.status === 404) return` branch purely defensively -- AWS's
  // docs mention a 404 can appear on a concurrent CONDITIONAL WRITE race, and if S3 ever answered
  // 404 to a conditional DELETE too, treating it as "already gone" is still the correct call. This
  // is NOT the path a real "object is already gone" guarded delete takes today (that is 412, see the
  // test above) -- this only proves the defensive branch itself does not regress.
  const { error } = await capture(
    () => new Response(null, { status: 404 }),
    () => deleteBlobHard('company', 'cases/brief.pdf', '"v1"'),
  );
  assert.equal(error, undefined, 'a literal 404 remains idempotent success (defensive branch)');
});

// ───────────── (e) fix item #1: a lost-response retry must not fabricate a false 412 ─────────────

test('GUARDED DELETE: a network error on the (successful, unseen) DELETE does NOT retry into a false BlobPreconditionFailedError', async () => {
  // Regression for fix item #1 (2026-08-18 FIX-FIRST gate). Before this fix, s3ObjectRequest passed
  // no `retries` override to fetchWithBudget for ANY write, including the conditional DELETE, so its
  // default (one retry on a network error / 429 / 5xx) applied here too. The real-world scenario:
  // the DELETE actually reaches S3 and succeeds server-side, but the 204 response is lost to a
  // transient network error before the client sees it. fetchWithBudget's catch-and-retry logic then
  // fires a SECOND request with the identical If-Match header -- except the key is now gone (or, on
  // a versioned bucket, its current version is a fresh delete marker), so that retry gets a 412 back,
  // and deleteObjectFromS3 throws BlobPreconditionFailedError saying "Nothing was deleted; investigate
  // and retry." Both clauses of that message would be false: something WAS deleted, by the FIRST
  // attempt, and no audit record exists anywhere for it -- silently swallowed by a precondition error
  // that misdescribes what actually happened, on attorney-privileged data.
  //
  // Simulated here as a thrown network error on attempt 1 (mirrors "the request landed and the
  // response never made it back," which fetch() surfaces as a rejected promise, not a Response), so
  // this proves the fix at the actual mechanism: fetchWithBudget's retry loop for a guarded delete
  // now runs with retries:0, so a network error on the one-and-only attempt propagates as the network
  // error itself -- an honest "we don't know what happened," never a fabricated 412 and never a
  // fabricated success.
  let attempts = 0;
  const { error, calls } = await capture(
    () => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed: socket hang up');
      // Never reached if retries:0 is honoured -- present only so a regression (an accidental retry)
      // surfaces as the OLD bug (a wrongly-thrown precondition failure) rather than as a hang or an
      // unrelated crash, making a regression here loud and specific.
      return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
    },
    () => deleteBlobHard('company', 'cases/brief.pdf', '"v1"'),
  );
  assert.equal(attempts, 1, 'no retry may be attempted for a guarded delete -- this is the whole fix');
  assert.notEqual(error, undefined, 'a transport failure must not resolve as success either');
  assert.equal(
    error instanceof BlobPreconditionFailedError,
    false,
    `a network error must surface as itself, not be reinterpreted as a precondition failure ` +
      `(got ${(error as Error)?.name}: ${(error as Error)?.message})`,
  );
  // No DELETE was ever recorded as having SUCCEEDED by this call's own bookkeeping (deletes(calls)
  // only counts requests captured by the mock, both of which are the same logical attempt slot here
  // since only one is ever issued) -- the point is there is exactly one attempt, not zero and not two.
  assert.equal(calls.length, 1);
});

test('UNGUARDED DELETE: a network error DOES retry (unconditional delete is safe to repeat) and the retry succeeding resolves cleanly', async () => {
  // The counterpart to the test above: an UNCONDITIONAL delete (no ifMatch) keeps the default retry,
  // because repeating it can never produce a different real-world outcome (S3 answers 204 whether or
  // not the key still exists). This pins that the fix is scoped to the guarded case only, not a
  // blanket "never retry a DELETE" change that would throw away real resilience for no reason.
  let attempts = 0;
  const { error, calls } = await capture(
    () => {
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed: socket hang up');
      return new Response(null, { status: 204 });
    },
    () => deleteBlobHard('company', 'cases/brief.pdf'),
  );
  assert.equal(error, undefined, 'the retried unconditional delete must resolve cleanly');
  assert.equal(attempts, 2, 'an unconditional delete keeps the default one retry');
  assert.equal(deletes(calls).length, 2, 'both the failed first attempt and the successful retry were issued as DELETE requests');
});

// ───────────── (d) the move must not claim what it did not do ─────────────

test('legal_blob_move does NOT report a completed move when the source delete never happened', async () => {
  // Sequence today: HEAD src (preflight, exists) -> HEAD dst (absent) -> PUT copy -> HEAD dst
  // (size) -> DELETE src, with NO delete-time HEAD in between (deleteObjectFromS3 no longer HEADs
  // at all, see its own doc comment). The mock's "any later HEAD of the source is denied" branch
  // below is therefore unreachable against the current code and is kept only as a regression pin:
  // if a delete-time HEAD is ever reintroduced (reopening the exact TOCTOU-plus-403-swallow this
  // file exists to prevent), this branch stands ready to make that regression fail loudly here
  // instead of silently reintroducing the old bug.
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


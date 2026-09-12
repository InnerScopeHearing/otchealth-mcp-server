/** Actual CTO Python inspection/publication -> gateway receipt acceptance.
 * node --import tsx scripts/verify-successor-materialization-wire.mjs MATERIALIZER_DIRECTORY [PYTHON]
 * Synthetic in-memory source only; no AWS calls or model execution.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyMaterializationReceipt } from '../src/server/materialized-catalog-pin.ts';

assert.ok(process.argv[2], 'MATERIALIZER_DIRECTORY is required');
const raw = execFileSync(process.argv[3] ?? 'python', [fileURLToPath(new URL('./verify-successor-materialization-wire.py', import.meta.url)), process.argv[2]], {encoding:'utf8', maxBuffer:256*1024});
const fixture = JSON.parse(raw), body = Buffer.from(fixture.receipt_base64, 'base64');
assert.equal(fixture.counts.eligible_rows, 1);
assert.equal(fixture.counts.excluded.unknown_extraction_quarantine, 2);
const verified = await verifyMaterializationReceipt(fixture.context, async request => {
  assert.equal(request.key, fixture.context.materialization.materialization_receipt_key);
  return {status:200, headers:new Headers({'x-amz-version-id':fixture.receipt_version}), body};
}, AbortSignal.timeout(5000));
assert.equal(verified.catalogVersionId, fixture.context.materialization.catalog_version_id);
console.log(JSON.stringify({schema:'successor-materialization-wire-check-v1', status:'passed', synthetic:true, aws_calls:0, eligible_rows:1, excluded_unknown_rows:2, receipt_bytes:body.length}));

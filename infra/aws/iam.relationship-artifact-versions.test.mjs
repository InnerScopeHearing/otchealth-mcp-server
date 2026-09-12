import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const policy = await readFile(new URL('./iam.tf', import.meta.url), 'utf8');
const run = 'run_88fc625a2b155c04d116762c4e4308501cb308a8ea81ad7c41451689fa7e0f3d';
const marker = 'Sid      = "ReadCfoRelationshipArtifactVersionsForRun88fc625a"';

test('the second CFO run can read immutable artifact versions without a finance-bucket version grant', () => {
  assert.ok(policy.includes(marker));
  const block = policy.slice(policy.indexOf(marker), policy.indexOf('# 2026-08-28: adjacent gap', policy.indexOf(marker)));

  assert.match(block, /Action\s+=\s+\["s3:GetObjectVersion"\]/);
  assert.match(block, new RegExp(`workers/cfo/${run}/relationship-producers/cfo-relationship-worker/resolution-artifacts/\\*`));
  assert.doesNotMatch(block, /s3:GetObject"|s3:PutObject|s3:DeleteObject|s3:ListBucket/);
  assert.doesNotMatch(block, /finance_legal_dr\.arn}\/\*"/);
});

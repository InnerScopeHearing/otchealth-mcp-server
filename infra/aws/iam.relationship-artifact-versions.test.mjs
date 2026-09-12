import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const policy = await readFile(new URL('./iam.tf', import.meta.url), 'utf8');
const marker = 'Sid      = "ReadCfoRelationshipArtifactVersions"';
const admissionMarker = 'Sid      = "ReadCfoCatalogPublishAdmissionsVersions"';

test('CFO relationship runs can read immutable artifact versions without a finance-bucket version grant', () => {
  assert.ok(policy.includes(marker));
  const block = policy.slice(policy.indexOf(marker), policy.indexOf(admissionMarker, policy.indexOf(marker)));

  assert.match(block, /Action\s+=\s+\["s3:GetObjectVersion"\]/);
  assert.match(block, /workers\/cfo\/run_\*\/relationship-producers\/cfo-relationship-worker\/resolution-artifacts\/sha256\/\?\?\/\*\.json/);
  assert.doesNotMatch(block, /s3:GetObject"|s3:PutObject|s3:DeleteObject|s3:ListBucket/);
  assert.doesNotMatch(block, /finance_legal_dr\.arn}\/\*"/);
  assert.doesNotMatch(block, /workers\/cfo\/\*\/relationship-producers/);
  assert.doesNotMatch(block, /workers\/clo|active-runs|catalog-cohorts|source-pilot/);
});

test('the active CFO cohort can read only immutable admission receipt versions', () => {
  assert.ok(policy.includes(admissionMarker));
  const block = policy.slice(policy.indexOf(admissionMarker), policy.indexOf('# 2026-08-28: adjacent gap', policy.indexOf(admissionMarker)));

  assert.match(block, /Action\s+=\s+\["s3:GetObjectVersion"\]/);
  assert.match(block, /catalog-cohorts\/cfo-catalog-publish-20260909-live\/server\/admissions\/run_\*\.json/);
  assert.doesNotMatch(block, /s3:GetObject"|s3:PutObject|s3:DeleteObject|s3:ListBucket/);
  assert.doesNotMatch(block, /finance_legal_dr\.arn}\/\*"/);
  assert.doesNotMatch(block, /server\/control|server\/proposals|workers\/|otchealthcfodata/);
});

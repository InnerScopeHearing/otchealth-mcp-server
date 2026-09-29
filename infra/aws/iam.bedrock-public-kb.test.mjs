import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const policy = await readFile(new URL('./iam.tf', import.meta.url), 'utf8');
const runtimeMarker = 'Sid      = "RetrieveManagedGraphRag"';
const dedicatedMarker = 'resource "aws_iam_role_policy" "public_company_shared_managed_kb_retrieve"';

test('public Managed KB permission is a separate one-statement inline policy with one exact resource', () => {
  const start = policy.indexOf(dedicatedMarker);
  assert.notEqual(start, -1, 'dedicated public knowledge-base policy exists');
  const next = policy.indexOf('\nresource ', start + dedicatedMarker.length);
  const block = policy.slice(start, next === -1 ? undefined : next);
  assert.match(block, /name\s*=\s*"PublicCompanySharedManagedKBRetrieve20260928"/);
  assert.match(block, /role\s*=\s*aws_iam_role\.task\.id/);
  assert.match(block, /Action\s+=\s+\["bedrock:Retrieve"\]/);
  assert.equal((block.match(/Action\s*=/g) ?? []).length, 1);
  assert.match(block, /Resource\s*=\s*"arn:aws:bedrock:us-east-1:900915535335:knowledge-base\/ZAYEKIX0RX"/);
  assert.equal((block.match(/Statement\s*=\s*\[\{/g) ?? []).length, 1);
  assert.equal((block.match(/knowledge-base\/[A-Za-z0-9]+/g) ?? []).length, 1);
  assert.doesNotMatch(block, /Resource\s*=\s*"\*"|knowledge-base\/\*/);
});

test('existing mixed-KB grant stays separate and dedicated policy docs give expected live readback', () => {
  const runtimeStart = policy.indexOf(runtimeMarker);
  const runtimeNext = policy.indexOf('Sid      = ', runtimeStart + runtimeMarker.length);
  const runtimeBlock = policy.slice(runtimeStart, runtimeNext);
  assert.match(runtimeBlock, /knowledge-base\/XNMHPUKGDT/);
  assert.doesNotMatch(runtimeBlock, /ZAYEKIX0RX/);

  const docsStart = policy.lastIndexOf('# Captured from the separately approved live inline policy', policy.indexOf(dedicatedMarker));
  const context = policy.slice(docsStart, policy.indexOf(dedicatedMarker));
  assert.match(context, /Do not apply it\s+# from Terraform/);
  assert.match(context, /aws iam get-role-policy --role-name otchealthTaskRole --policy-name PublicCompanySharedManagedKBRetrieve20260928/);
  assert.match(context, /aws iam simulate-principal-policy/);
  assert.match(context, /allowed for ZAYEKIX0RX and implicitDeny for XNMHPUKGDT/);
});

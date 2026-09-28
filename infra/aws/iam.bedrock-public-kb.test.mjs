import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const policy = await readFile(new URL('./iam.tf', import.meta.url), 'utf8');
const marker = 'Sid      = "RetrieveManagedGraphRag"';

test('Bedrock Retrieve is limited to the two exact approved knowledge-base ARNs', () => {
  const start = policy.indexOf(marker);
  assert.notEqual(start, -1, 'managed GraphRAG statement exists');
  const next = policy.indexOf('Sid      = ', start + marker.length);
  const block = policy.slice(start, next === -1 ? undefined : next);
  assert.match(block, /Action\s+=\s+\["bedrock:Retrieve"\]/);
  assert.match(block, /knowledge-base\/XNMHPUKGDT/);
  assert.match(block, /knowledge-base\/ZAYEKIX0RX/);
  assert.equal((block.match(/knowledge-base\/[A-Za-z0-9]+/g) ?? []).length, 2);
  assert.doesNotMatch(block, /Resource\s*=\s*"\*"|knowledge-base\/\*/);
  assert.doesNotMatch(block, /bedrock:(?!Retrieve\b)[A-Za-z]+/);
});

test('IAM comment documents readback without authorizing an apply or deployment', () => {
  const start = policy.lastIndexOf('# The gateway sends Retrieve only to the one approved managed GraphRAG', policy.indexOf(marker));
  const context = policy.slice(start, policy.indexOf(marker));
  assert.match(context, /aws iam get-role-policy --role-name otchealthTaskRole --policy-name runtime-access/);
  assert.match(context, /verify only these exact knowledge-base ARNs are present for Retrieve/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/build-gateway-ecr.yml', import.meta.url), 'utf8');
const credentialStep = workflow.match(/- name: Configure AWS credentials \(GitHub OIDC\)([\s\S]*?)(?=\n      - name:)/)?.[1];

test('gateway ECR build uses only its fixed GitHub OIDC role', () => {
  assert.ok(credentialStep, 'credential configuration step exists');
  assert.match(credentialStep, /role-to-assume: arn:aws:iam::900915535335:role\/otchealth-github-ecr-push-gateway/);
  assert.match(credentialStep, /unset-current-credentials: true/);
  assert.match(credentialStep, /role-session-name: gateway-ecr-push-\$\{\{ github\.run_id \}\}/);
  assert.match(credentialStep, /aws-region: us-east-1/);
  assert.doesNotMatch(workflow, /vars\.AWS_OIDC_ROLE_ARN|ECR_AWS_ACCESS_KEY_ID|ECR_AWS_SECRET_ACCESS_KEY|aws-access-key-id:|aws-secret-access-key:/);
});

test('gateway ECR build retains its tag and source identity contract', () => {
  assert.match(workflow, /TAG="\$\{REQUESTED:-\$\(git rev-parse --short HEAD\)\}"/);
  assert.match(workflow, /--build-arg "GIT_SHA=\$GITHUB_SHA"/);
  assert.match(workflow, /--tag "\$\{\{ steps\.ecr\.outputs\.registry \}\}\/otchealth-mcp-gateway:\$\{\{ steps\.tag\.outputs\.tag \}\}"/);
  assert.match(workflow, /runtime-acceptance\/ecr-digests\.json/);
});

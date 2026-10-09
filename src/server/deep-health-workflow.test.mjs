import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile('.github/workflows/verify-aws-deep-health.yml', 'utf8');
const script = await readFile('scripts/check-deep-health.py', 'utf8');

test('manual gateway verification is dispatch-only and least-privileged', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /expected_image_tag:[\s\S]*required: true[\s\S]*type: string/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.ok(workflow.includes("if: github.repository == 'InnerScopeHearing/otchealth-mcp-server' && github.ref == 'refs/heads/main'"));
  assert.doesNotMatch(workflow, /(^|\n)\s*(push|pull_request|schedule):/);
  assert.match(workflow, /ADMIN_REVOKE_TOKEN: \$\{\{ secrets\.ADMIN_REVOKE_TOKEN \}\}/);
});

test('verification fails closed and validates the pinned deep-health contract', () => {
  assert.match(script, /if not token\.strip\(\):[\s\S]*admin_token_missing/);
  assert.match(script, /admin_token_invalid/);
  assert.match(script, /::add-mask::\{token\}/);
  assert.match(script, /payload\.get\("status"\) != "ok" or payload\.get\("readiness"\) != "ready"/);
  assert.match(script, /EXPECTED_IMAGE_DIGEST = "sha256:5f17111e63aa99743b6f17d92d80a5c105d4d7954208f248107c3aa75fca007f"/);
  assert.match(script, /EXPECTED_TASK_DEFINITION = "otchealth-gateway:200"/);
  assert.match(script, /if set\(payload\) != DEEP_FIELDS:/);
  assert.match(script, /if status == "down":/);
  assert.match(script, /if payload\["postgres_tls_verify"\] is not True:/);
  assert.match(script, /receipt = \{/);
});

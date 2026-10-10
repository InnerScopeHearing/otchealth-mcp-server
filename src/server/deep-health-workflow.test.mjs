import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile('.github/workflows/verify-aws-deep-health.yml', 'utf8');
const script = await readFile('scripts/check-deep-health.py', 'utf8');

test('manual gateway verification is dispatch-only and least-privileged', () => {
  assert.match(workflow, /workflow_dispatch:/);
  for (const input of ['expected_image_tag', 'expected_image_digest', 'expected_task_definition']) {
    assert.match(workflow, new RegExp(`${input}:[\\s\\S]*?required: true[\\s\\S]*?type: string`));
    assert.match(workflow, new RegExp(`${input.toUpperCase()}: \\$\\{\\{ inputs\\.${input} \\}\\}`));
  }
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.ok(workflow.includes("if: github.repository == 'InnerScopeHearing/otchealth-mcp-server' && github.ref == 'refs/heads/main'"));
  assert.doesNotMatch(workflow, /(^|\n)\s*(push|pull_request|schedule):/);
  assert.match(workflow, /ADMIN_REVOKE_TOKEN: \$\{\{ secrets\.ADMIN_REVOKE_TOKEN \}\}/);
});

test('verification validates and compares each caller-provided receipt before authentication', () => {
  assert.match(script, /if not token\.strip\(\):[\s\S]*admin_token_missing/);
  assert.match(script, /admin_token_invalid/);
  assert.match(script, /re\.fullmatch\(r"\[0-9a-f\]\{64\}", token\)/);
  assert.match(script, /::add-mask::\{token\}/);
  assert.match(script, /class NoRedirect\(urllib\.request\.HTTPRedirectHandler\)/);
  assert.match(script, /def redirect_request\([\s\S]*return None/);
  assert.match(script, /raise CheckFailure\("request_failed"\) from None/);
  assert.match(script, /MAX_RESPONSE_BYTES = 65536/);
  assert.match(script, /object_pairs_hook=reject_duplicate_keys/);
  assert.match(script, /Only fixed, allowlisted receipt fields are written to stdout/);
  assert.match(script, /payload\.get\("status"\) != "ok" or payload\.get\("readiness"\) != "ready"/);
  assert.match(script, /IMAGE_TAG_PATTERN = re\.compile\(r"\[0-9a-f\]\{40\}/);
  assert.match(script, /IMAGE_DIGEST_PATTERN = re\.compile\(r"sha256:\[0-9a-f\]\{64\}"\)/);
  assert.match(script, /TASK_DEFINITION_PATTERN = re\.compile\(r"otchealth-gateway:\[1-9\]\[0-9\]\*"\)/);
  assert.match(script, /def validate_expected_receipt\([\s\S]*expected_image_tag_invalid[\s\S]*expected_image_digest_invalid[\s\S]*expected_task_definition_invalid/);
  assert.match(script, /revision\.get\("image_tag"\) != expected_tag/);
  assert.match(script, /revision\.get\("image_digest"\) != expected_digest/);
  assert.match(script, /revision\.get\("task_definition"\) != expected_task_definition/);
  assert.match(script, /health = get_json\("\/health"\)[\s\S]*verify_revision\(health,[\s\S]*deep = get_json\("\/health\/deep", token=token\)/);
  assert.match(script, /if set\(payload\) != DEEP_FIELDS:/);
  assert.match(script, /if status == "down":/);
  assert.match(script, /if not isinstance\(status, str\) or status not in VALID_STATUSES:/);
  assert.match(script, /for field in REQUIRED_OK_FIELDS:/);
  assert.match(script, /if payload\["postgres_tls_verify"\] is not True:/);
  assert.match(script, /receipt = \{/);
});

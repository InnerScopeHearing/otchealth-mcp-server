import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_CONTENT_BEARING_WRITE_TOOLS,
  GITHUB_REPOSITORY_WRITE_TOOLS,
} from '../config/github-operator.js';
import { evaluateGitHubPreShareGate } from './github-pre-share.js';

test('clean engineering writes remain available across every repository mutation', () => {
  for (const tool of GITHUB_REPOSITORY_WRITE_TOOLS) {
    const outcome = evaluateGitHubPreShareGate(tool, 'developer', {
      owner: 'InnerScopeHearing',
      repo: 'otchealth-mcp-server',
      message: 'fix: keep connector policy deterministic',
      nested: { files: [{ path: 'src/policy.ts', content: 'export const enabled = true;' }] },
    });
    assert.deepEqual(outcome, {
      blocked: false,
      code: 'clear',
      reason: 'GitHub repository write passed the protected-content pre-share gate.',
    }, tool);
  }
});

test('every repository mutation scans nested values and object keys for protected markers', () => {
  for (const tool of GITHUB_REPOSITORY_WRITE_TOOLS) {
    const valueHit = evaluateGitHubPreShareGate(tool, 'cto', {
      owner: 'InnerScopeHearing',
      nested: { payloads: [{ body: 'Copied from legal-personal for publication.' }] },
    });
    assert.equal(valueHit.blocked, true, `${tool} nested value`);
    assert.equal(valueHit.code, 'protected_content', `${tool} nested value`);

    const keyHit = evaluateGitHubPreShareGate(tool, 'cto', {
      inputs: { '[MNPI] acquisition_target': 'redacted' },
    });
    assert.equal(keyHit.blocked, true, `${tool} nested key`);
    assert.equal(keyHit.code, 'protected_content', `${tool} nested key`);
  }
});

test('nested file and workflow input markers are detected after 20k without truncation', () => {
  const lateMarker = `${'safe code\n'.repeat(2_500)}[MNPI] do not publish`;
  for (const [tool, args] of [
    ['github_push_files', {
      owner: 'InnerScopeHearing',
      repo: 'otchealth-mcp-server',
      files: [{ path: 'src/large.ts', content: lateMarker }],
    }],
    ['github_dispatch_workflow', {
      owner: 'InnerScopeHearing',
      repo: 'otchealth-mcp-server',
      inputs: { release_notes: lateMarker },
    }],
  ] as const) {
    const outcome = evaluateGitHubPreShareGate(tool, 'developer', args);
    assert.equal(outcome.blocked, true, tool);
    assert.equal(outcome.code, 'protected_content', tool);
  }
});

test('clo-personal is hard-refused on broad content while Exec retains clean engineering writes', () => {
  for (const tool of GITHUB_CONTENT_BEARING_WRITE_TOOLS) {
    const personal = evaluateGitHubPreShareGate(tool, ' CLO-PERSONAL ', {
      owner: 'InnerScopeHearing',
      body: 'ordinary-looking text without an MNPI marker',
    });
    assert.equal(personal.blocked, true, tool);
    assert.equal(personal.code, 'personal_legal_boundary', tool);
    assert.match(personal.reason, /clo-personal lane/i, tool);

    const executive = evaluateGitHubPreShareGate(tool, 'exec', {
      owner: 'InnerScopeHearing',
      body: 'ordinary clean engineering change',
    });
    assert.equal(executive.blocked, false, `exec:${tool}`);
  }

  const metadata = evaluateGitHubPreShareGate('github_pr_update_branch', 'clo-personal', {
    owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', pull_number: 42,
  });
  assert.equal(metadata.blocked, false);
});

test('malformed or cyclic repository arguments fail closed', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const args of [cyclic, { invalid: Symbol('not-json') }, new Date()]) {
    const outcome = evaluateGitHubPreShareGate('github_create_branch', 'developer', args);
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.code, 'scan_failed');
    assert.match(outcome.reason, /failed CLOSED/i);
  }
});

test('non-repository and isolated broker tools are outside this direct-write gate', () => {
  for (const tool of ['github_make_broker', 'github_get_file_contents', 'memory_remember']) {
    const outcome = evaluateGitHubPreShareGate(tool, 'clo-personal', { body: '[MNPI]' });
    assert.equal(outcome.blocked, false, tool);
  }
});

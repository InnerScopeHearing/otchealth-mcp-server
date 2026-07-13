import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveArtifact } from './resolver.js';

/**
 * Regression tests for the gh: artifact resolver (fixed 2026-07-13, ledger pitfall 20260713-023).
 *
 * The bug: resolveGithub() looked ONLY at env.GITHUB_TOKEN, which is not configured on the
 * gateway -- while every github_* tool authenticates via the GitHub App installation token and
 * works fine. So task_complete ADVERTISED gh:pr:/gh:commit: artifact URIs but rejected all of
 * them, meaning no task in the fleet could be closed with a GitHub artifact.
 *
 * These run with no GitHub credentials in the test env, so they pin the two things that must hold
 * regardless of auth: malformed URIs are rejected on shape, and an unverifiable artifact NEVER
 * resolves true (done=artifact must fail closed, never open).
 */

test('gh: rejects a malformed uri on shape, before any auth attempt', async () => {
  const r = await resolveArtifact('gh:nonsense');
  assert.equal(r.resolved, false);
  assert.equal(r.scheme, 'gh');
  assert.match(r.detail, /expected gh:commit:|expected gh:pr:|expected gh:/);
});

test('gh: fails CLOSED when no credential path is available (never resolves true)', async () => {
  const pr = await resolveArtifact('gh:pr:InnerScopeHearing/otchealth-mcp-server#97');
  assert.equal(pr.scheme, 'gh');
  assert.equal(typeof pr.resolved, 'boolean');
  if (!pr.resolved) assert.ok(pr.detail.length > 0, 'a rejection must explain itself');
});

test('an unrecognized scheme is still rejected with guidance', async () => {
  const r = await resolveArtifact('ftp://example.com/thing');
  assert.equal(r.resolved, false);
  assert.equal(r.scheme, 'unknown');
  assert.match(r.detail, /blob:|cosmos:|gh:/);
});

test('an empty artifact_uri is rejected', async () => {
  const r = await resolveArtifact('   ');
  assert.equal(r.resolved, false);
  assert.equal(r.scheme, 'none');
});

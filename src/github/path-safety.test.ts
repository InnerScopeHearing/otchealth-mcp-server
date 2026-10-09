import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGitHubApiUrl,
  encodeGitHubHierarchicalRoutePath,
  encodeGitHubOpaqueRouteParam,
  encodeGitHubRepositorySegment,
  GitHubPathSafetyError,
  validateGitHubRepositoryToolArgs,
} from './path-safety.js';

const hostileSegments = [
  '.',
  '..',
  '%2e',
  '%2E%2E',
  '.%2e',
  '%2e.',
  '%252e%252e',
  '%25252e%25252e',
  '/',
  '\\',
  '%2f',
  '%2F',
  '%252f',
  '%5c',
  '%5C',
  '%255c',
  '?outside=true',
  '#outside',
  '%3foutside',
  '%23outside',
  '%',
  '%2',
  '\u0000',
  '%00',
] as const;

function isPathError(error: unknown): boolean {
  return error instanceof GitHubPathSafetyError && error.code === 'github_invalid_path';
}

test('canonical GitHub path construction preserves ordinary nested file/ref/workflow names', () => {
  assert.equal(encodeGitHubHierarchicalRoutePath('.github/workflows/ci.yml'), '.github/workflows/ci.yml');
  assert.equal(encodeGitHubHierarchicalRoutePath('heads/feature/operator-access'), 'heads/feature/operator-access');
  assert.equal(encodeGitHubHierarchicalRoutePath('docs/release notes.md'), 'docs/release%20notes.md');
  assert.equal(encodeGitHubOpaqueRouteParam('needs.review'), 'needs.review');
  assert.equal(encodeGitHubOpaqueRouteParam('feature/operator-access'), 'feature%2Foperator-access');
  assert.equal(encodeGitHubOpaqueRouteParam('type/bug'), 'type%2Fbug');

  const url = buildGitHubApiUrl(
    '/repos/InnerScopeHearing/otchealth-mcp-server/contents/.github/workflows/ci.yml?ref=feature%2Foperator-access',
  );
  assert.equal(url.origin, 'https://api.github.com');
  assert.equal(url.pathname, '/repos/InnerScopeHearing/otchealth-mcp-server/contents/.github/workflows/ci.yml');
  assert.equal(url.searchParams.get('ref'), 'feature/operator-access');
  assert.equal(
    buildGitHubApiUrl('/repos/InnerScopeHearing/safe/branches/feature%2Foperator-access').pathname,
    '/repos/InnerScopeHearing/safe/branches/feature%2Foperator-access',
  );
});

test('raw, encoded, and multiply encoded semantic traversal segments fail closed', () => {
  for (const hostile of hostileSegments) {
    assert.throws(() => encodeGitHubOpaqueRouteParam(hostile), isPathError, hostile);
    assert.throws(() => encodeGitHubHierarchicalRoutePath(`safe/${hostile}/file.txt`), isPathError, hostile);
  }
  for (const value of ['type%2Fbug', 'type%252Fbug', 'feature%5Cbug', 'feature%255Cbug']) {
    assert.throws(() => encodeGitHubOpaqueRouteParam(value), isPathError, value);
  }
  for (const value of ['safe%2Ffile.ts', 'safe%252Ffile.ts', 'safe%5Cfile.ts', 'safe%255Cfile.ts']) {
    assert.throws(() => encodeGitHubHierarchicalRoutePath(value), isPathError, value);
  }
});

test('repository owner/name segments reject raw, encoded, and multiply encoded separators', () => {
  for (const value of ['InnerScopeHearing/external', 'InnerScopeHearing\\external', '%2fexternal', '%252fexternal', 'safe%5cexternal', 'safe%255cexternal']) {
    assert.throws(() => encodeGitHubRepositorySegment(value), isPathError, value);
  }
});

test('assembled routes cannot normalize or escape their repository prefix', () => {
  const hostileRoutes = [
    '/repos/InnerScopeHearing/safe/contents/..',
    '/repos/InnerScopeHearing/safe/contents/%2e%2e',
    '/repos/InnerScopeHearing/safe/contents/%252e%252e',
    '/repos/InnerScopeHearing/safe/git/refs/../..',
    '/repos/InnerScopeHearing/safe/labels/.%2e',
    '/repos/InnerScopeHearing/safe/actions/workflows/%2fexternal/dispatches',
    '/repos/InnerScopeHearing/safe/contents/%5cexternal',
    '/repos/InnerScopeHearing/safe/contents/file#outside',
    '//api.github.com/repos/InnerScopeHearing/safe',
  ];
  for (const route of hostileRoutes) {
    assert.throws(() => buildGitHubApiUrl(route), isPathError, route);
  }
});

test('tool argument validator covers nested files and every route-bearing argument family', () => {
  const unsafeArguments = [
    { owner: 'InnerScopeHearing', repo: 'safe', path: '../outside' },
    { owner: 'InnerScopeHearing', repo: 'safe', branch: '%252e%252e/main' },
    { owner: 'InnerScopeHearing', repo: 'safe', ref: 'heads/%2e%2e/main' },
    { owner: 'InnerScopeHearing', repo: 'safe', base: 'main', head: '%2fexternal' },
    { owner: 'InnerScopeHearing', repo: 'safe', label_name: '..' },
    { owner: 'InnerScopeHearing', repo: 'safe', workflow_id: '%255coutside' },
    { owner: 'InnerScopeHearing', repo: 'safe', files: [{ path: 'src/ok.ts' }, { path: '../../outside.ts' }] },
  ];
  for (const args of unsafeArguments) {
    assert.throws(() => validateGitHubRepositoryToolArgs(args), isPathError, JSON.stringify(args));
  }

  assert.doesNotThrow(() => validateGitHubRepositoryToolArgs({
    owner: 'InnerScopeHearing',
    repo: 'otchealth-mcp-server',
    branch: 'feature/operator-access',
    workflow_id: '.github/workflows/ci.yml',
    files: [{ path: 'src/github/path-safety.ts' }],
  }));
});

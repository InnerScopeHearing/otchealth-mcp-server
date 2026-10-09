/**
 * GitHub REST route safety.
 *
 * WHATWG URL construction normalizes literal and percent-encoded dot segments. A caller-controlled
 * file/ref/label value therefore must never be interpolated into a route until every semantic path
 * segment has been checked. The decoder loop catches raw, encoded, and multiply encoded variants;
 * canonical construction then encodes each already-validated segment exactly once.
 */

const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_DECODE_PASSES = 8;

export class GitHubPathSafetyError extends Error {
  readonly code = 'github_invalid_path';
  readonly status = 0;
  readonly nextStep = 'Use canonical GitHub owner, repository, file, branch, ref, label, and workflow identifiers without dot segments or encoded separators.';

  constructor(message: string) {
    super(message);
    this.name = 'GitHubPathSafetyError';
  }
}

function assertSafeDecodedValue(value: string, allowSlash: boolean): void {
  if (!value || value.includes('\\') || value.includes('?') || value.includes('#') || CONTROL.test(value)) {
    throw new GitHubPathSafetyError('Refusing an unsafe GitHub API path value.');
  }
  const components = value.split('/');
  if ((!allowSlash && components.length !== 1) || components.some((component) => !component || component === '.' || component === '..')) {
    throw new GitHubPathSafetyError('Refusing an unsafe GitHub API path component.');
  }
}

/**
 * Inspect both the caller's raw value and encoded/double-encoded interpretations. Opaque route
 * parameters may contain ordinary slashes (for example `feature/foo` or `type/bug`) because the
 * whole value is encoded once; hierarchical paths validate the same components before preserving
 * their separator slashes. Encoded separators are inspected rather than trusted.
 */
function assertRawSemanticValue(value: string, allowRawSlash: boolean): void {
  let current = value;
  assertSafeDecodedValue(current, allowRawSlash);
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      throw new GitHubPathSafetyError('Refusing a malformed encoded GitHub API path segment.');
    }
    if (decoded === current) return;
    // A separator supplied as percent-encoded caller input is ambiguous and must fail closed.
    // Raw separators are accepted only where the endpoint's semantics intentionally allow them.
    assertSafeDecodedValue(decoded, false);
    current = decoded;
  }
  throw new GitHubPathSafetyError('Refusing an excessively encoded GitHub API path segment.');
}

function assertAssembledRouteSegment(value: string): void {
  let current = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    assertSafeDecodedValue(current, true);
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      throw new GitHubPathSafetyError('Refusing a malformed encoded GitHub API path segment.');
    }
    if (decoded === current) return;
    current = decoded;
  }
  throw new GitHubPathSafetyError('Refusing an excessively encoded GitHub API path segment.');
}

/** Encode one opaque route parameter (branch/ref/label/workflow) exactly once. */
export function encodeGitHubOpaqueRouteParam(value: unknown): string {
  if (typeof value !== 'string') throw new GitHubPathSafetyError('GitHub API path segments must be strings.');
  assertRawSemanticValue(value, true);
  return encodeURIComponent(value);
}

/** Encode an owner/repository (or similarly strict) route segment; separators are never valid. */
export function encodeGitHubRepositorySegment(value: unknown): string {
  if (typeof value !== 'string') throw new GitHubPathSafetyError('GitHub API repository segments must be strings.');
  assertRawSemanticValue(value, false);
  return encodeURIComponent(value);
}

/** Encode a slash-delimited Contents file path or git-ref route one segment at a time. */
export function encodeGitHubHierarchicalRoutePath(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new GitHubPathSafetyError('GitHub API paths must be non-empty strings.');
  assertRawSemanticValue(value, true);
  const segments = value.split('/');
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * Validate an already-assembled relative API path and construct its fixed-origin URL. The raw and
 * final pathname must match byte-for-byte; any WHATWG normalization is a refusal. Repository routes
 * additionally remain under the exact owner/repository prefix present before URL construction.
 */
export function buildGitHubApiUrl(path: string, origin = 'https://api.github.com'): URL {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('\0') || path.includes('#')) {
    throw new GitHubPathSafetyError('Refusing an invalid GitHub API path.');
  }
  const queryIndex = path.indexOf('?');
  const rawPathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const segments = rawPathname.split('/');
  if (segments[0] !== '' || segments.slice(1).some((segment) => !segment)) {
    throw new GitHubPathSafetyError('Refusing an empty GitHub API route segment.');
  }
  // A safely encoded opaque parameter may decode to a slash-bearing identifier (for example a
  // branch named feature/foo). Recursively inspect those decoded components for dot traversal,
  // ambiguous empty components, controls, backslashes, and multiply encoded equivalents.
  for (let index = 1; index < segments.length; index += 1) {
    const isRepositorySelector = segments[1] === 'repos' && (index === 2 || index === 3);
    if (isRepositorySelector) assertRawSemanticValue(segments[index], false);
    else assertAssembledRouteSegment(segments[index]);
  }

  const url = new URL(path, origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.port) {
    throw new GitHubPathSafetyError('Refusing a non-GitHub API origin.');
  }
  if (url.pathname !== rawPathname) {
    throw new GitHubPathSafetyError('Refusing a normalized GitHub API pathname.');
  }

  if (segments[1] === 'repos' && segments.length >= 4) {
    const repositoryPrefix = `/repos/${segments[2]}/${segments[3]}`;
    if (url.pathname !== repositoryPrefix && !url.pathname.startsWith(`${repositoryPrefix}/`)) {
      throw new GitHubPathSafetyError('Refusing a GitHub API route outside its repository prefix.');
    }
  }
  return url;
}

const HIERARCHICAL_ARGUMENTS = new Set(['path', 'ref']);
const REPOSITORY_ARGUMENTS = new Set(['owner', 'repo']);
const OPAQUE_ARGUMENTS = new Set(['label_name', 'workflow_id', 'branch', 'base', 'head']);

/** Validate route-bearing top-level tool arguments before dry-run or handler execution. */
export function validateGitHubRepositoryToolArgs(args: unknown): void {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new GitHubPathSafetyError('GitHub repository arguments must be an object.');
  }
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (HIERARCHICAL_ARGUMENTS.has(key) && typeof value === 'string') encodeGitHubHierarchicalRoutePath(value);
    if (REPOSITORY_ARGUMENTS.has(key) && typeof value === 'string') encodeGitHubRepositorySegment(value);
    if (OPAQUE_ARGUMENTS.has(key) && typeof value === 'string') encodeGitHubOpaqueRouteParam(value);
  }

  const files = (args as Record<string, unknown>).files;
  if (Array.isArray(files)) {
    for (const file of files) {
      if (file && typeof file === 'object' && !Array.isArray(file) && typeof (file as Record<string, unknown>).path === 'string') {
        encodeGitHubHierarchicalRoutePath((file as Record<string, unknown>).path);
      }
    }
  }
}

/** Route-only GitHub App installation token for the Developer Git read pilot. */

// Fixed GitHub repository IDs. Never derive token scope from an unverified caller value.
export const DEVELOPER_GIT_REPOSITORY_IDS: Readonly<Record<string, number>> = Object.freeze({
  iheartest: 1_231_250_532,
  'aware-aural-rehab': 1_233_196_567,
  'otchealth-companion': 1_249_343_095,
  innerease: 1_254_834_356,
  fourvault: 1_249_412_178,
  flatstick: 1_257_949_398,
  'plantid-app': 1_271_529_369,
  fictionary: 1_257_976_525,
});
export const DEVELOPER_GIT_TOKEN_EARLY_REFRESH_MS = 60_000;

export interface DeveloperGitTokenMintRequest {
  repository_ids: readonly [number];
  permissions: { contents: 'read' };
}

export interface DeveloperGitMintedToken {
  token: string;
  expires_at: string;
}

export type DeveloperGitTokenMinter = (
  request: DeveloperGitTokenMintRequest,
) => Promise<DeveloperGitMintedToken>;

/**
 * Cache repository-scoped, contents:read tokens independently for each fixed repository.
 */
export function createDeveloperGitReadTokenProvider(
  mint: DeveloperGitTokenMinter,
  now: () => number = Date.now,
): (repo: string) => Promise<string> {
  const cache = new Map<string, { token: string; expiresAtMs: number }>();
  const inFlight = new Map<string, Promise<string>>();

  return async (repo) => {
    if (!Object.hasOwn(DEVELOPER_GIT_REPOSITORY_IDS, repo)) throw new Error('invalid_developer_git_repository');
    const cached = cache.get(repo);
    const currentTime = now();
    if (cached && currentTime < cached.expiresAtMs - DEVELOPER_GIT_TOKEN_EARLY_REFRESH_MS) {
      return cached.token;
    }
    const existing = inFlight.get(repo);
    if (existing) return existing;

    const request: DeveloperGitTokenMintRequest = {
      repository_ids: [DEVELOPER_GIT_REPOSITORY_IDS[repo]],
      permissions: { contents: 'read' },
    };
    const pending = (async () => {
      let minted: DeveloperGitMintedToken;
      try {
        minted = await mint(request);
      } catch {
        throw new Error('github_developer_git_token_mint_failed');
      }
      const expiry = Date.parse(minted?.expires_at ?? '');
      if (typeof minted?.token !== 'string' || minted.token.length === 0 ||
          !Number.isFinite(expiry) || expiry <= now() + DEVELOPER_GIT_TOKEN_EARLY_REFRESH_MS) {
        throw new Error('github_developer_git_token_response_invalid');
      }
      cache.set(repo, { token: minted.token, expiresAtMs: expiry });
      return minted.token;
    })();
    inFlight.set(repo, pending);
    try {
      return await pending;
    } finally {
      if (inFlight.get(repo) === pending) inFlight.delete(repo);
    }
  };
}

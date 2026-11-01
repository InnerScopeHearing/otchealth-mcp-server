/** Route-only GitHub App installation token for the Developer Git read pilot. */

// Fixed mapping from the sole Developer Git route repo to its GitHub numeric ID. Any allowlist
// expansion must deliberately redesign this token scope and update the invariant test.
export const DEVELOPER_GIT_TOKEN_REPOSITORY_NAME = 'iheartest';
export const DEVELOPER_GIT_REPOSITORY_ID = 1_231_250_532;
export const DEVELOPER_GIT_TOKEN_EARLY_REFRESH_MS = 60_000;

export interface DeveloperGitTokenMintRequest {
  repository_ids: readonly [typeof DEVELOPER_GIT_REPOSITORY_ID];
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
 * Create an isolated cache for the single-repository, contents:read Git transport.
 * No caller-controlled repository or permission parameters are accepted.
 */
export function createDeveloperGitReadTokenProvider(
  mint: DeveloperGitTokenMinter,
  now: () => number = Date.now,
): () => Promise<string> {
  let cachedToken: string | null = null;
  let expiresAtMs = 0;
  let mintInFlight: Promise<string> | null = null;

  return async () => {
    const currentTime = now();
    if (cachedToken && currentTime < expiresAtMs - DEVELOPER_GIT_TOKEN_EARLY_REFRESH_MS) {
      return cachedToken;
    }
    if (mintInFlight) return mintInFlight;

    const request: DeveloperGitTokenMintRequest = {
      repository_ids: [DEVELOPER_GIT_REPOSITORY_ID],
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
      cachedToken = minted.token;
      expiresAtMs = expiry;
      return cachedToken;
    })();
    mintInFlight = pending;
    try {
      return await pending;
    } finally {
      if (mintInFlight === pending) mintInFlight = null;
    }
  };
}


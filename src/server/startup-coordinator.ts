export interface StartupEnvironment {
  CANARY_MODE: boolean;
}

export interface RevocationReadiness {
  static_token_auth_ready: boolean;
  state: string;
}

export interface StartupDependencies {
  loadRevocations: () => Promise<number>;
  getRevocationStoreStatus: () => RevocationReadiness;
  startRevocationReloader: () => void;
  startDeindexResweepReloader: () => void;
  runCloudBrowserPolling: (canaryMode: boolean) => () => void;
  onRevocationUnavailable?: (status: RevocationReadiness) => void;
}

export interface StartupState {
  revokedCount: number;
  revocationStatus: RevocationReadiness;
}

/**
 * Performs the shared pre-listen startup contract. The real entrypoint supplies its native
 * modules; tests supply counters and failures. Initial revocation loading always occurs. Canary
 * mode then fails closed on unavailable auth and starts no autonomous reloader.
 */
export async function initializeStartup(
  env: StartupEnvironment,
  deps: StartupDependencies,
): Promise<StartupState> {
  const revokedCount = await deps.loadRevocations();
  const revocationStatus = deps.getRevocationStoreStatus();
  if (!revocationStatus.static_token_auth_ready) {
    deps.onRevocationUnavailable?.(revocationStatus);
    if (env.CANARY_MODE) throw new Error('canary_auth_not_ready');
  }
  if (!env.CANARY_MODE) {
    deps.startRevocationReloader();
    deps.startDeindexResweepReloader();
  }
  return { revokedCount, revocationStatus };
}

/** Starts post-listen workers. Canary mode is passed through so the browser runtime can enforce
 * its own no-claim invariant as well as the coordinator gate. */
export function startPostListenWorkers(
  env: StartupEnvironment,
  deps: Pick<StartupDependencies, 'runCloudBrowserPolling'>,
): () => void {
  return deps.runCloudBrowserPolling(env.CANARY_MODE);
}

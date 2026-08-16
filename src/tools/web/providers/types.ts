/**
 * Shared result shape every web_search PROVIDER normalizes to. The dispatcher
 * (src/tools/web/web-search.ts) hands this straight into the tool's `data` payload with no further
 * reshaping, so this interface IS the drop-in contract: whichever provider WEB_SEARCH_PROVIDER
 * selects, a caller of the `web_search` MCP tool sees the exact same shape it always has.
 *
 * Mirrors the tool's `outputShape` (`{answer, citations, mode, error?}`) minus the `'blocked'` mode
 * value, which is a provider-agnostic MNPI-gate outcome decided BEFORE any provider is even
 * selected (see web-search.ts) -- a provider itself only ever returns one of the three values below.
 */
export interface WebSearchResult {
  /** Synthesized answer text (already length-capped by the provider). Empty string, never absent,
   *  when mode is not 'web' -- callers can always safely read `.answer` without a null check. */
  answer: string;
  /** Source citations, provider-normalized to `{title, url}` objects. Always an array, even when
   *  empty -- an empty array on mode:'web' means "searched, found nothing", which is a REAL and
   *  distinct outcome from mode:'unconfigured' (never configured) or mode:'error' (the call failed).
   *  Collapsing those three into the same empty-array shape is exactly the silent-failure class this
   *  contract is designed to prevent; `mode` is what a caller must branch on, not citations.length. */
  citations: unknown[];
  /**
   *   'web'           a real search ran and (successfully) returned a result, possibly with zero
   *                    citations if nothing relevant was found -- that is a legitimate empty result,
   *                    not a failure.
   *   'unconfigured'   the active provider has no credentials set. NEVER reported as 'web' with an
   *                    empty answer/citations -- that would silently read as "searched, found
   *                    nothing" when in fact no search was attempted at all.
   *   'error'          the provider was configured but the call itself failed (network, timeout,
   *                    non-2xx, auth failure, ...). See `error` for detail.
   */
  mode: 'web' | 'unconfigured' | 'error';
  /** Present on mode:'error' (and safe to omit otherwise). Never present on mode:'web', even for a
   *  zero-citation result -- a successful-but-empty search is not an error. */
  error?: string;
}

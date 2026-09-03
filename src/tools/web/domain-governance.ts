/**
 * Domain governance shared by every Tavily-backed open-web tool (web_search, web_research,
 * web_extract -- Task G-3, 2026-09-03). Env-configured allow/deny lists
 * (WEB_SEARCH_DOMAIN_ALLOW/_DENY, see config/env.ts's schema comment for the full contract) that a
 * provider consults BOTH to shape its own request (Tavily's include_domains/exclude_domains, where
 * that parameter exists) and to post-filter whatever it gets back -- a code-level backstop that
 * does not depend on how strictly the third party itself honors its own parameter (Tavily's docs
 * describe /research's `include_domains` as only a "soft preference", for example, not a hard
 * filter -- see docs.tavily.com/documentation/api-reference/endpoint/research, verified 2026-09-03).
 *
 * DENY ALWAYS WINS: domainAllowed() below checks the deny list FIRST and unconditionally, so a
 * domain an operator mistakenly lists on BOTH env vars is still excluded -- the allow list is never
 * even consulted for a denied domain. This mirrors safety/mnpi-gate.ts's design philosophy (a hard
 * rule checked before any softer one) without reusing that module directly (MNPI gating is about
 * CONTENT provenance; this is about DESTINATION domains -- two independent, unrelated axes that
 * happen to share a "deny is absolute" shape).
 *
 * HOST MATCHING is domain-or-subdomain (`example.com` also matches `sub.example.com`), the exact
 * convention safety/mnpi-gate.ts's INTERNAL_EMAIL_DOMAINS already uses for its own domain
 * allowlist -- kept consistent rather than inventing a second matching rule in this codebase.
 *
 * FAIL-OPEN ON AN UNPARSEABLE/MISSING HOST: a citation with no `url` (title-only -- web_search's
 * provider already accepts these, see tavily-web-search.ts) or an unparseable URL has no host to
 * govern, so it passes through unfiltered by domainAllowed()/filterCitationsByDomain(). This is
 * deliberately DIFFERENT from filterUrlsByDomain() below, used by web_extract, where every item
 * DOES carry a URL (the caller supplied it, or Tavily echoed the one it actually fetched) -- there
 * is no legitimate "no host to check" case there, so an unparseable URL is treated as UNGOVERNABLE
 * and dropped rather than let through.
 */

export interface DomainGovernance {
  /** Lowercased domain allowlist. Empty = no allow restriction (subject to `deny` below). */
  allow: string[];
  /** Lowercased domain denylist. Always wins over `allow` -- see domainAllowed(). */
  deny: string[];
}

/** The empty governance value: no allow restriction, nothing denied. Every provider's default
 *  parameter value below is this constant, so "governance not configured" is always a true no-op
 *  (identical request body, identical result set) rather than merely "an empty array happens to
 *  behave like a no-op today". */
export const NO_DOMAIN_GOVERNANCE: DomainGovernance = { allow: [], deny: [] };

function parseDomainCsv(csv: string): string[] {
  return csv
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** Reads WEB_SEARCH_DOMAIN_ALLOW/_DENY off an already-loaded Env (or any object with those two
 *  string fields -- a `Pick<Env, ...>` rather than the full `Env` so this stays trivially testable
 *  with a plain literal, matching this directory's existing "config resolved by the caller, passed
 *  in as a plain argument" convention, e.g. tavily-web-search.ts's `apiKey` parameter). */
export function loadDomainGovernance(env: { WEB_SEARCH_DOMAIN_ALLOW: string; WEB_SEARCH_DOMAIN_DENY: string }): DomainGovernance {
  return {
    allow: parseDomainCsv(env.WEB_SEARCH_DOMAIN_ALLOW),
    deny: parseDomainCsv(env.WEB_SEARCH_DOMAIN_DENY),
  };
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function matchesAnyDomain(host: string, domains: string[]): boolean {
  return domains.some((d) => hostMatchesDomain(host, d));
}

/** The lowercased hostname of `url`, or null when `url` does not parse as an absolute URL at all
 *  (e.g. empty string, a bare word). Exported so callers/tests can reason about the same host a
 *  provider will govern by, without re-deriving the parsing rule. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when `url` is permitted under `gov`. See the module header for the full deny-wins /
 * fail-open-on-no-host contract. A caller that wants "no host = excluded" instead (web_extract's
 * result/URL lists, where every item is expected to carry a real URL) should treat hostOf(url) ===
 * null as its own drop condition rather than relying on this function's fail-open default -- see
 * filterUrlsByDomain() below, which does exactly that.
 */
export function domainAllowed(url: string, gov: DomainGovernance): boolean {
  const host = hostOf(url);
  if (!host) return true;
  if (matchesAnyDomain(host, gov.deny)) return false;
  if (gov.allow.length > 0) return matchesAnyDomain(host, gov.allow);
  return true;
}

/**
 * Tavily's own `include_domains`/`exclude_domains` request parameters, derived from `gov`. Omits a
 * key entirely when its list is empty rather than sending `[]` -- Tavily's documented default for
 * both is already `[]`, so this is behaviorally identical either way, but omitting the key keeps a
 * request body byte-for-byte unchanged from before this feature existed whenever governance is not
 * configured (every other `*_PROVIDER`/`*_BACKEND` switch in this codebase preserves the same
 * "unset = untouched request shape" property).
 */
export function tavilyDomainRequestParams(gov: DomainGovernance): { include_domains?: string[]; exclude_domains?: string[] } {
  const params: { include_domains?: string[]; exclude_domains?: string[] } = {};
  if (gov.allow.length > 0) params.include_domains = gov.allow;
  if (gov.deny.length > 0) params.exclude_domains = gov.deny;
  return params;
}

/**
 * Post-filter for citation-shaped results (web_search/web_research: `{title?, url?}`). A citation
 * with no `url` at all (title-only -- an accepted, pre-existing shape, see tavily-web-search.ts)
 * passes through unfiltered: there is no host to govern. Returns the SAME array reference when
 * governance is fully empty, so a caller/test can tell "untouched" apart from "filtered to
 * everything" by identity if it ever needs to (not relied on by any current caller, just a cheap
 * correctness property of a true no-op).
 */
export function filterCitationsByDomain<T extends { url?: string }>(items: T[], gov: DomainGovernance): T[] {
  if (gov.allow.length === 0 && gov.deny.length === 0) return items;
  return items.filter((item) => !item.url || domainAllowed(item.url, gov));
}

/**
 * Filter for URL-shaped items where EVERY item is expected to carry a real URL (web_extract's
 * caller-supplied request list, and the results Tavily hands back) -- unlike a citation, there is
 * no legitimate "no host to check" case here, so an item whose URL does not even parse is treated
 * as ungovernable and DROPPED (the opposite fail-open default from domainAllowed()/
 * filterCitationsByDomain() above, deliberately -- see the module header). Returns both halves so a
 * caller can report exactly which URLs were governed out, rather than only the survivors.
 */
export function filterUrlsByDomain<T extends { url: string }>(items: T[], gov: DomainGovernance): { kept: T[]; dropped: T[] } {
  if (gov.allow.length === 0 && gov.deny.length === 0) return { kept: items, dropped: [] };
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const item of items) {
    const host = hostOf(item.url);
    (host && domainAllowed(item.url, gov) ? kept : dropped).push(item);
  }
  return { kept, dropped };
}

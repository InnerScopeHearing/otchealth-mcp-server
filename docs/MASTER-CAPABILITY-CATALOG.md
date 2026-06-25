# Master Capability Catalog

The single inventory every fleet agent uses to understand the whole toolset — on ANY platform
(Hyperagent, Claude, ChatGPT, Perplexity, Copilot, Cursor), without that platform's own connector
setup. The **live, authoritative** source is the gateway tool `catalog_master`; this doc is the
human mirror.

## How an agent discovers everything (one call each)
- `catalog_master` → every wired **tool** (with its execution RULE), every **service** (wired +
  planned, with ring/auth/rule), the full **skills** + **plugins** list, and the **governance** policy.
  Optional `section` = `tools | services | skills | plugins | governance`.
- `catalog_skill(name)` → fetch a skill's `SKILL.md` (how-to) on demand; no arg lists all skills.
- `agent_persona(agent)` → fetch an agent's role definition (who you are). Persona + `memory_pack`
  (what you know) = full cold-start bootstrap on any platform.

## The rule model (expose-all, govern-execution)
Every agent can **SEE** every tool. Some actions are **role-gated for EXECUTION** — encoded centrally
in `src/catalog/governance.ts` and enforced in `registry.ts` (role check precedes the write gate).
Current rules:
- `depot_*`, `build_*`, `release_*` → **CTO only** (all agents may read build status; only the CTO
  kicks off a build / TestFlight upload — single initiator for consistency).
- `cloudflare_create_dns_record` → **CTO only** (DNS is CTO-owned infrastructure).

Identity comes from the caller's OAuth token (per-agent client via `OAUTH_CLIENTS`; the original
single connector is identified by `OAUTH_DEFAULT_AGENT`). `memory_pack` / `memory_remember` default
to the caller's agent lane.

## Services (wired = tools live; planned = known, not yet wired)
**Wired:** Customer.io, Shopify, Intercom, n8n, Cloudflare (email + DNS), Microsoft Graph (COO
send-as), Stripe (read), Netlify, Gumroad, kb-memory (shared brain), Capability Catalog.
**Planned (on the roadmap, surfaced so agents know they're coming):** Depot, PostHog, RevenueCat,
Twilio/ElevenLabs, Sentry, GitHub, Mercury, QuickBooks/Xero, Plaid, HeyGen.

## Ring safety (the one hard boundary)
The gateway carves PHI out by design and is non-PHI/non-MNPI/non-privileged. The external-client
surface NEVER exposes PHI (MedReview), MNPI/securities (Capital/INND), or attorney-privileged (CLO)
data, tools, or ledgers. Finance/PHI services above are listed for fleet awareness but stay on the
trusted engines; widen external access only via signed provider BAAs.

## Counts (snapshot; `catalog_master` is always current)
~48 tools · ~20 services · ~90 skills · plugins · 4 governance rules.

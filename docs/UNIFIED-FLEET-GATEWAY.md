# Unified Fleet Gateway — otchealth-mcp-server (architecture + roadmap)

**Decision (Matt, 2026-06-13):** `otchealth-mcp-server` is THE single MCP gateway to
the entire OTCHealth / InnerScope tech stack. Every AI client (Claude, Perplexity,
the Hyperagent fleet, anything future) connects to this ONE remote MCP and gets the
whole stack. It does not matter which AI Matt is working with - they all reach the
same tools through one connector. No sprawl of separate per-tool MCPs; no "which AI
has which tool" gaps.

This refines the earlier "skill vs MCP per tool" note: the gateway is the **access
layer** for the stack. Skills remain for local/creative work (designer); CI/build
stays in GitHub Actions (the gateway dispatches + reads, it is not a build runner).

## Why one gateway (not 20 MCPs, not per-AI setup)
- **Uniform access.** Any MCP client gets the full stack via one connector + one bearer.
- **One control plane** (already built): bearer auth, `/admin/revoke` kill-switch,
  audit logger, compliance guardrail. One place to harden, rotate, and audit.
- **Agents never hold raw keys** - they hold the gateway bearer; the gateway holds
  the upstream credentials, least-privilege.
- **No drift.** We just lived the n8n-MCP-pointing-at-a-dead-host failure. One
  maintained gateway kills that whole class of bug.

## Current state (Phase 1, BUILT)
Fastify + `@modelcontextprotocol/sdk`, Streamable-HTTP `/mcp` (JSON-RPC 2.0), bearer
auth + revocation kill-switch, `src/audit/logger.ts`, `src/compliance/guardrail.ts`.
Integration clients already present: **Customer.io, Cloudflare, Microsoft Graph,
Intercom, n8n, Shopify, Stripe**. 13+ tools live (Customer.io, Cloudflare DNS/email,
Graph). Deployed on Azure (COO-25). ADR-001 locked the architecture.

## Target: full-stack coverage (one module per stack member)
Each module = typed Zod tools + a least-privilege client + audit + compliance gate.
Priority order:
1. **Depot - the FULL API, not just grant-burn** (Matt directive: know the whole
   tool, do not leave features on the table). Projects, builds (list/status/logs),
   build cache management, org usage + grant burn, runner config, registry/cache.
2. **PostHog** - projects, insights/funnels, feature flags, experiments,
   annotations, cohorts (management API). PHI-hardened projects stay read-only via
   the BAA path; never open replay through here.
3. **GitHub** passthrough (Claude has the GitHub MCP already; expose it so non-Claude
   clients + fleet automation get it through the one gateway too).
4. **Netlify, RevenueCat** (v2 API until its MCP is allowlisted), **Twilio +
   ElevenLabs** (voice fleet ops), **Gumroad, Daytona, Sentry** (if retained),
   **Notion** passthrough.

## The Capability Catalog (the "deep dive" Matt asked for)
A built-in meta toolset so agents always use the right tool and we never leave
features unused:
- `catalog_list_tools` - every tool the gateway exposes, grouped by service, with
  params + required scopes.
- `catalog_service_capabilities <service>` - the FULL upstream surface (from each
  provider's OpenAPI / published spec), each capability flagged **WIRED** vs
  **AVAILABLE-NOT-WIRED**, so gaps are visible at a glance.
- `catalog_audit_unused` - capabilities our plan/grant includes that we are NOT
  using yet (the "features on the table" report) - rendered to a human page for Matt.

## Security model (non-negotiable - this gateway is keys-to-the-kingdom)
- Gateway holds credentials; agents hold only the gateway bearer. Per-client bearer
  + scopes + `/admin/revoke`. Every call audit-logged.
- Least-privilege per upstream credential; write/destructive tools gated + logged.
- **PHI CARVE-OUT (BAA, absolute):** this gateway is the NON-PHI ring. MedReview PHI
  DATA operations do NOT pass through it. Non-PHI infra config for MedReview may;
  no PHI data tool, ever. This holds regardless of the single-secret-store decision.
- **Securities firewall:** INND / IR-facing actions stay gated to Capital + counsel
  even when reachable through the gateway.

## How clients connect (the realization of the vision)
The gateway is a deployed remote MCP. In each client (Claude, Perplexity, Hyperagent)
add a custom MCP connector: URL `https://<host>/mcp` + that client's bearer. One
connector = the full stack, identical across every AI.

## Roadmap
- **Phase 2:** deploy hardened + connect Claude & Perplexity as custom MCP connectors;
  add the **Depot (full)** + **PostHog** modules + the **Capability Catalog**.
- **Phase 3:** GitHub / Netlify / RevenueCat / Twilio+ElevenLabs / Gumroad / Daytona.
- **Phase 4:** `catalog_audit_unused` on a review cadence; per-credential rotation
  automation; per-client scoped bearers for the Hyperagent fleet.

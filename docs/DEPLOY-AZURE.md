# Deploy: historical note (superseded by CI/CD)

This document originally covered the one-time 2026-06-25 migration off Railway onto Azure Container
Apps, run via a manual `bash scripts/deploy-azure.sh` invocation. That migration is long done and
the script it described is now DELETED (2026-07-21): it targeted the container app by the stale
name `gateway-mcp` (the real deployed app is `otchealth-mcp-gateway`), assumed a single-replica
topology that is no longer true, and set several Container App secrets from empty-default shell
variables (`${PERPLEXITY_CONNECTOR_TOKEN:-}` and similar), which would silently blank those secrets
on the live app if anyone ever ran it again with an incomplete environment. Keeping a working-looking
but dangerous alternate deploy path around, next to the real one, is worse than having none.

## The real deploy path (current)

Every push to `main` (i.e. every merge) automatically deploys via `.github/workflows/deploy.yml`:
builds the image once, promotes it by immutable `@sha256` digest, brings up a GREEN revision at 0%
traffic, asserts health + the full tool catalog, asserts deep dependency reachability (Cosmos /
Search / Foundry), shifts traffic, then prunes stale revisions. It can also be triggered manually via
`workflow_dispatch`. Read that workflow file directly for the exact steps and required repo secrets;
it is the single source of truth for how this gateway ships, not this document.

## Rails (still current)
- Gateway stays read-only by default (write/high-risk tools off). PHI ring stays carved out.
- `oauth-client-secret`, `oauth-token-signing-secret`, the connector token, and the admin revoke
  token are all on the rotate-before-launch list.

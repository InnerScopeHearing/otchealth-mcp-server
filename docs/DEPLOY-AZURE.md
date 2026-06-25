# Deploy: Railway -> Azure Container Apps (+ OAuth 2.1)

Part of the Azure-credits-maximization directive (2026-06-25): move the gateway off Railway onto
Azure Container Apps so more Azure services are in active use under the Microsoft for Startups
program, and add real OAuth 2.1 so the gateway connects as a standard Hyperagent custom MCP.

## Target infra (matthew@otchealth.app credits subscription)
- Subscription: `55c84f6b-ef90-4259-a58b-50835cc4cab4`
- Resource group: `rg-otchealth-apps-prod`
- Container Apps env: `cae-otchealth-apps`
- ACR: `otchealthacr`
- Container App: `gateway-mcp` (external ingress, target port 8080, single replica)
- DNS: `mcp.otchealth.app` (Cloudflare zone `38d8cf730302bced2bc7f14bd107ec49`)

Single replica is intentional: the OAuth authorization-code store is in-memory (5 min TTL). Access
and refresh tokens are signed HS256 JWTs (stateless), so a restart does not invalidate live tokens.

## 1. Generate OAuth secrets (once)
Generate three high-entropy values and store them in GCP Secret Manager (the vault), never in chat:
- `oauth-client-id`        (the value you paste into Hyperagent's "Client ID")
- `oauth-client-secret`    (Hyperagent "Client Secret")
- `oauth-token-signing-secret` (>=32 bytes; the gateway's JWT signing key, never leaves the server)

The Hyperagent redirect URI (shown in the connector form) goes in `OAUTH_REDIRECT_URIS` (comma list).

## 2. Build + deploy
```
export PERPLEXITY_CONNECTOR_TOKEN=... ADMIN_REVOKE_TOKEN=... \
       OAUTH_CLIENT_ID=... OAUTH_CLIENT_SECRET=... OAUTH_TOKEN_SIGNING_SECRET=... \
       OAUTH_REDIRECT_URIS="https://hyperagent.com/api/mcp-server/oauth/callback" \
       CIO_SITE_ID=... CIO_TRACK_KEY=... CIO_APP_API_BEARER=... N8N_WEBHOOK_SECRET=... \
       AZURE_COMMONS_STORAGE_KEY=...
bash scripts/deploy-azure.sh
```
`az acr build` builds remotely (no local Docker). The script creates/updates the Container App,
sets secrets, binds env via `secretref:`, and prints the app FQDN. Verify `GET /health` and the
OAuth metadata at `/.well-known/oauth-authorization-server`.

## 3. Cutover DNS (preserve-then-cut; confirm with Matt)
1. Keep Railway live.
2. Point Cloudflare `mcp.otchealth.app` CNAME at the Container App FQDN (proxied). Container Apps
   needs the custom domain + managed cert bound (`az containerapp hostname add` / `bind`).
3. Verify `https://mcp.otchealth.app/health` resolves to Azure.
4. Only then decommission the Railway service (cut its billing).

## 4. Connect in Hyperagent (OAuth)
Settings -> Integrations -> Add custom/remote MCP server:
- Name: `otchealth-gateway`
- URL: `https://mcp.otchealth.app/mcp`
- Bring my own OAuth app: checked
- Copy the form's Redirect URI into `OAUTH_REDIRECT_URIS` (step 1) if it differs from the assumed value
- Client ID: `oauth-client-id`; Client Secret: `oauth-client-secret`
- Endpoints auto-discover via the well-known metadata; otherwise set Authorization/Token endpoints
  to `https://mcp.otchealth.app/oauth/authorize` and `/oauth/token`, Scopes: `mcp`
- Check "I trust this server".

## Rails
- Gateway stays read-only by default (write/high-risk tools off). PHI ring stays carved out.
- `oauth-client-secret`, `oauth-token-signing-secret`, the connector token, and the admin revoke
  token are all on the rotate-before-launch list.

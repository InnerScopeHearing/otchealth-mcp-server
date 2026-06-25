#!/usr/bin/env bash
# Build + deploy the OTCHealth MCP gateway to Azure Container Apps (Azure-credits-maximization
# directive 2026-06-25: move off Railway onto Azure). Idempotent: re-running updates the app.
#
# Prereqs: az CLI logged in (SP or device code) on the matthew@otchealth.app credits subscription;
# secrets sourced from GCP Secret Manager (the claude-driver SA) or passed in env. NEVER echo secrets.
#
# Usage:
#   export ACR=otchealthacr RG=rg-otchealth-apps-prod ENVNAME=cae-otchealth-apps APP=gateway-mcp
#   bash scripts/deploy-azure.sh
set -euo pipefail

SUB="${SUB:-55c84f6b-ef90-4259-a58b-50835cc4cab4}"   # matthew@otchealth.app credits subscription
RG="${RG:-rg-otchealth-apps-prod}"
ENVNAME="${ENVNAME:-cae-otchealth-apps}"
ACR="${ACR:-otchealthacr}"
APP="${APP:-gateway-mcp}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"
IMAGE="${ACR}.azurecr.io/${APP}:${IMAGE_TAG}"

az account set --subscription "$SUB"

echo "==> Building image in ACR (remote build, no local Docker needed): $IMAGE"
az acr build --registry "$ACR" --image "${APP}:${IMAGE_TAG}" --image "${APP}:latest" .

# Secrets are set as Container App secrets (referenced by env vars). Populate these env vars from the
# vault/Secret Manager BEFORE running, or set them once via `az containerapp secret set`. The list
# mirrors .env.example. OAuth + connector + admin tokens are required; the rest are per-integration.
SECRET_ARGS=(
  "perplexity-connector-token=${PERPLEXITY_CONNECTOR_TOKEN:-}"
  "admin-revoke-token=${ADMIN_REVOKE_TOKEN:-}"
  "oauth-client-id=${OAUTH_CLIENT_ID:-}"
  "oauth-client-secret=${OAUTH_CLIENT_SECRET:-}"
  "oauth-token-signing-secret=${OAUTH_TOKEN_SIGNING_SECRET:-}"
  "cio-site-id=${CIO_SITE_ID:-}"
  "cio-track-key=${CIO_TRACK_KEY:-}"
  "cio-app-api-bearer=${CIO_APP_API_BEARER:-}"
  "n8n-webhook-secret=${N8N_WEBHOOK_SECRET:-}"
  "azure-commons-storage-key=${AZURE_COMMONS_STORAGE_KEY:-}"
)

EXISTS="$(az containerapp show -g "$RG" -n "$APP" --query name -o tsv 2>/dev/null || true)"

if [ -z "$EXISTS" ]; then
  echo "==> Creating Container App $APP (single replica; in-memory auth-code store)"
  az containerapp create \
    -g "$RG" -n "$APP" --environment "$ENVNAME" \
    --image "$IMAGE" \
    --registry-server "${ACR}.azurecr.io" \
    --ingress external --target-port 8080 --transport auto \
    --min-replicas 1 --max-replicas 1 \
    --cpu 0.5 --memory 1.0Gi
fi

echo "==> Setting secrets (values never printed)"
az containerapp secret set -g "$RG" -n "$APP" --secrets "${SECRET_ARGS[@]}" >/dev/null

echo "==> Updating image + env (secretref bindings)"
az containerapp update -g "$RG" -n "$APP" --image "$IMAGE" \
  --set-env-vars \
    NODE_ENV=production PORT=8080 \
    READ_ONLY_MODE=true ENABLE_WRITE_TOOLS=false ENABLE_HIGH_RISK_TOOLS=false DRY_RUN_DEFAULT=true \
    PUBLIC_BASE_URL=https://mcp.otchealth.app \
    OAUTH_REDIRECT_URIS="${OAUTH_REDIRECT_URIS:-}" \
    N8N_BASE_URL=https://automation.otchealth.app \
    PERPLEXITY_CONNECTOR_TOKEN=secretref:perplexity-connector-token \
    ADMIN_REVOKE_TOKEN=secretref:admin-revoke-token \
    OAUTH_CLIENT_ID=secretref:oauth-client-id \
    OAUTH_CLIENT_SECRET=secretref:oauth-client-secret \
    OAUTH_TOKEN_SIGNING_SECRET=secretref:oauth-token-signing-secret \
    CIO_SITE_ID=secretref:cio-site-id \
    CIO_TRACK_KEY=secretref:cio-track-key \
    CIO_APP_API_BEARER=secretref:cio-app-api-bearer \
    N8N_WEBHOOK_SECRET=secretref:n8n-webhook-secret \
    AZURE_COMMONS_STORAGE_KEY=secretref:azure-commons-storage-key

FQDN="$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)"
echo "==> Deployed. Container App FQDN: https://${FQDN}"
echo "==> Verify:   curl -sS https://${FQDN}/health"
echo "==> Next: repoint Cloudflare CNAME mcp.otchealth.app -> ${FQDN} (preserve-then-cut from Railway)."

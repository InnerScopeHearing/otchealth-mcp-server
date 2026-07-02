# ============================================================
# Stage 1: build
# ============================================================
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

# ============================================================
# Stage 2: runtime
# ============================================================
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

# curl: used by the eval harness (eval-runner.mjs) and the HEALTHCHECK probe.
RUN apk add --no-cache curl

RUN addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
# Ship the standalone eval harness (.mjs, not compiled) so the nightly eval Container Apps Job
# can run `node eval/eval-runner.mjs` against the gateway for the regression baseline.
COPY --from=build --chown=app:app /app/src/eval ./eval

# ── Datadog observability (APM + logs + metrics) ──────────────────────────────
# serverless-init wraps the app process and forwards dd-trace traces, logs, and metrics
# to Datadog with no separate agent (works on Azure Container Apps + Cloud Run). It is
# INERT unless DD_API_KEY is provided to the environment, so this image is safe to ship
# everywhere; telemetry only flows where DD_API_KEY is set (the per-env gate). No
# DD_API_KEY is baked in here, by design (the gateway is keys-to-the-kingdom).
COPY --from=datadog/serverless-init:1 --chown=app:app /datadog-init /app/datadog-init
ENV DD_SITE=us3.datadoghq.com
ENV DD_SERVICE=gateway-mcp
ENV DD_LOGS_INJECTION=true
ENV DD_SERVERLESS_LOG_PATH=/dev/stdout

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/bin/sh", "-c", "if [ -n \"$DD_API_KEY\" ]; then exec /app/datadog-init \"$@\"; else exec \"$@\"; fi", "sh"]
CMD ["node", "dist/server/index.js"]

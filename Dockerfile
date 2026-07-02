# ============================================================
# Stage 1: build
# ============================================================
FROM node:22 AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

# ============================================================
# Stage 2: runtime
# ============================================================
# glibc base (Debian slim), NOT alpine/musl: Datadog serverless-init's /datadog-init is a
# glibc-linked binary and cannot exec on musl. Build stage is full node:22 (glibc) so native
# node_modules match the runtime ABI.
FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

# curl: eval harness + HEALTHCHECK probe. ca-certificates: REQUIRED so the Go-based Datadog
# serverless-init binary can verify TLS to the DD intake (trace.agent/http-intake/*.us3). Without it,
# node:22-slim has no system CA bundle and serverless-init drops every payload with
# "x509: certificate signed by unknown authority" (Node's own fetch bundles CAs, so direct API
# calls still work, which is why only serverless-init forwarding failed).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system app && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app

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
COPY --from=datadog/serverless-init:1.9.16 --chown=app:app /datadog-init /app/datadog-init
ENV DD_SITE=us3.datadoghq.com
ENV DD_SERVICE=gateway-mcp
ENV DD_APM_ENABLED=true
# In-container mode: serverless-init disables the trace UDS and serves the trace-agent on TCP
# 127.0.0.1:8126. dd-trace v5 probes the Unix socket first, so point it explicitly at the TCP
# endpoint to avoid the socket-first miss and guarantee spans reach serverless-init.
ENV DD_TRACE_AGENT_URL=http://127.0.0.1:8126
ENV DD_LOGS_ENABLED=true
ENV DD_LOGS_INJECTION=true
ENV DD_SOURCE=nodejs
# NOTE: DD_SERVERLESS_LOG_PATH is intentionally NOT set. It activates serverless-init's FILE-TAILING
# (sidecar) mode; in this in-container/entrypoint-wrap topology serverless-init captures the child's
# stdout/stderr directly once DD_LOGS_ENABLED=true. Setting it (esp. to /dev/stdout) silently breaks
# log forwarding (cmd/serverless-init/log/log.go: envVarTailFilePath).

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/bin/sh", "-c", "if [ -n \"$DD_API_KEY\" ]; then exec /app/datadog-init \"$@\"; else exec \"$@\"; fi", "sh"]
CMD ["node", "dist/server/index.js"]

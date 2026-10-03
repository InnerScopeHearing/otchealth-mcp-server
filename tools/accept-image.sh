#!/usr/bin/env bash
# Offline runtime acceptance for one immutable platform child manifest.
# Inputs are supplied by the existing ECR build job after parsing ECR's manifest list.
# No credentials are accepted by this script. It never publishes, probes a provider, or
# sends an HTTP request outside the isolated image container.
set -euo pipefail

IMAGE_REF=${1:?usage: accept-image.sh IMAGE@sha256:CHILD_DIGEST linux/amd64|linux/arm64}
PLATFORM=${2:?usage: accept-image.sh IMAGE@sha256:CHILD_DIGEST linux/amd64|linux/arm64}
[[ "$IMAGE_REF" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "require child manifest digest, never tag" >&2; exit 2; }
case "$PLATFORM" in linux/amd64|linux/arm64) ;; *) echo "unsupported platform" >&2; exit 2 ;; esac
ARCH=${PLATFORM#linux/}
case "$ARCH" in amd64) NODE_ARCH=x64 ;; arm64) NODE_ARCH=arm64 ;; esac

docker pull --platform "$PLATFORM" "$IMAGE_REF"

# Verify runtime identity, OS, Node module ABI, installed CA material, ELF architecture,
# glibc runtime and Datadog binary executable. The `--network none` namespace blocks all
# egress; empty DD_API_KEY prevents transmission even if the init binary starts.
timeout 90s docker run --rm --platform "$PLATFORM" --network none \
  -e EXPECT_ARCH="$NODE_ARCH" \
  "$IMAGE_REF" /bin/sh -ceu '
    . /etc/os-release
    test "${VERSION_CODENAME:-}" = trixie
    node -e '\''
      const tls = require("node:tls");
      const fs = require("node:fs");
      const { X509Certificate } = require("node:crypto");
      if (process.versions.node.split(".")[0] !== "22") throw Error(`Node ${process.versions.node}`);
      if (process.arch !== process.env.EXPECT_ARCH) throw Error(`arch ${process.arch}`);
      if (!process.versions.modules) throw Error("missing Node module ABI");
      if (!process.report.getReport().header.glibcVersionRuntime) throw Error("glibc runtime missing");
      if (!tls.rootCertificates.length) throw Error("Node built-in roots missing");
      const extra = process.env.NODE_EXTRA_CA_CERTS;
      if (!extra || !fs.statSync(extra).isFile() || fs.statSync(extra).size < 1000) throw Error("extra CA bundle missing");
      const parsePemBundle = path => {
        const pem = fs.readFileSync(path, "utf8");
        const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
        if (!certs.length) throw Error(`${path} contains no certificates`);
        certs.forEach(cert => new X509Certificate(cert));
        return {bytes: fs.statSync(path).size, certificates: certs.length};
      };
      const extraStats = parsePemBundle(extra);
      const systemStats = parsePemBundle("/etc/ssl/certs/ca-certificates.crt");
      const elf = fs.readFileSync("/app/datadog-init");
      if (elf.toString("hex", 0, 4) !== "7f454c46") throw Error("Datadog init is not ELF");
      const machine = elf.readUInt16LE(18);
      const expectedMachine = process.arch === "x64" ? 62 : 183;
      if (machine !== expectedMachine) throw Error(`Datadog init ELF machine ${machine} != ${expectedMachine}`);
      const pprof = require("@datadog/pprof");
      if (typeof pprof.time?.start !== "function") throw Error("Datadog native profiler module did not load");
      console.log(JSON.stringify({node: process.versions.node, modules: process.versions.modules, arch: process.arch, glibc: process.report.getReport().header.glibcVersionRuntime, extraCa: extraStats, systemCa: systemStats, datadogElfMachine: machine, nativeProfilerLoaded: true}));
    '\''
    # Invoke Datadog init with no key and a harmless child; assert it actually execs the child.
    env -u DD_API_KEY DD_SITE=us3.datadoghq.com /app/datadog-init /bin/sh -ceu "test \"\${DD_API_KEY:-}\" = \"\"; echo datadog-init-child-ok"
  '

# Full app boot + /health check in an isolated network namespace. Placeholder tokens satisfy
# config validation; all connector/provider actions remain dark, memory revocations are local,
# and the request is only the built-in health endpoint. Neither body nor env contains customer data.
CID=$(docker run -d --platform "$PLATFORM" --network none \
  -e NODE_ENV=development -e PORT=8080 -e REVOCATION_MEMORY_ONLY_MODE=development \
  -e CIO_SITE_ID=offline-test -e CIO_TRACK_KEY=offline-test -e CIO_APP_API_BEARER=offline-test \
  -e PERPLEXITY_CONNECTOR_TOKEN=offline-placeholder-token-000000000000000000000000 \
  -e ADMIN_REVOKE_TOKEN=offline-placeholder-token-000000000000000000000000 \
  -e N8N_WEBHOOK_SECRET=offline-placeholder-secret-00000000000000000000000 \
  -e READ_ONLY_MODE=true -e ENABLE_WRITE_TOOLS=false -e ENABLE_HIGH_RISK_TOOLS=false \
  -e DRY_RUN_DEFAULT=true \
  "$IMAGE_REF")
HEALTH_FILE=$(mktemp)
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true; rm -f "$HEALTH_FILE"' EXIT

healthy=false
for _ in $(seq 1 30); do
  if docker exec "$CID" curl -fsS http://127.0.0.1:8080/health > "$HEALTH_FILE" 2>/dev/null; then
    if node -e '
      const h = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      if (h.status !== "ok" || h.readiness !== "ready" || h.service !== "otchealth-mcp-server") process.exit(1);
      if (h.read_only_mode !== true || h.enable_write_tools !== false || h.enable_high_risk_tools !== false || h.dry_run_default !== true) process.exit(1);
      const gated = ["provider_writes","prompt_avatar_writes","avatar_video_writes","reference_look_writes","video_agent_chat_writes","video_agent_generation","asset_writes","translation_writes","tts_writes","metadata_writes"];
      if (!h.heygen || gated.some(key => h.heygen[key] !== false)) process.exit(1);
      console.log(JSON.stringify({status:h.status, readiness:h.readiness, service:h.service, read_only_mode:h.read_only_mode, enable_write_tools:h.enable_write_tools, enable_high_risk_tools:h.enable_high_risk_tools, dry_run_default:h.dry_run_default, revision:h.revision ?? null, tool_count:h.tool_count}));
    ' "$HEALTH_FILE"; then healthy=true; break; fi
  fi
  sleep 1
done
[[ "$healthy" == true ]] || { docker logs "$CID" >&2; echo "offline app health failed for $PLATFORM" >&2; exit 1; }
echo "OFFLINE_RUNTIME_ACCEPTANCE_PASS platform=$PLATFORM ref=$IMAGE_REF"

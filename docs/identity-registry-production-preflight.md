# Identity registry production preflight

Run this only after the source owner has made a signed explicit-ID export available. The tool validates the same `identity-registry-production-v1` configuration that normal gateway startup uses. It reads no finance document body, does not write S3, and does not print the configuration, public key, object pins, policy hashes, or bearer token.

Required inputs are a source-owner signed `source-identity-registry-explicit-export-manifest-v1` manifest and current pointer, its public Ed25519 key, the exact CFO run and source catalog pins, a signed partition-manifest version, separate source and registry-store prefixes, and reviewed S3 policy and storage-scope hashes. The private signing key stays with the source owner and never belongs in gateway configuration.

First build the gateway, then validate a configuration file held outside the repository:

```powershell
npm run build; node tools/identity-registry-production-preflight.mjs --config C:\secure\identity-registry-config.json
```

The expected result is `config_valid`. It proves only schema validity, not source authority or storage readiness.

For the read-only live check, place the CFO bearer token in the process environment and supply the source binding hash. The hash must be the canonical SHA-256 binding identifier supplied by the signed source coverage export. The command calls only `https://mcp.otchealth.app`, rejects caller-supplied origins, bounds the response to 16 KiB, and accepts readiness only when the deployed gateway returns both `coverage_ready: true` and `reason: "coverage_checked"`.

```powershell
$env:GRAPH_IDENTITY_REGISTRY_CFO_BEARER_TOKEN = '<read from the approved secret channel>'; node tools/identity-registry-production-preflight.mjs --config C:\secure\identity-registry-config.json --check-live --source-binding-sha256 <64-lowercase-hex>
```

The command remains blocked for an absent or invalid source export, a policy or versioning failure, a wrong run, a missing binding, a stale pointer, an unavailable registry, or any non-CFO identity. A `ready` result is one per-binding gate and does not establish a complete CFO graph. A verified X-to-Y-to-Z answer still requires the bounded graph query's fresh source and identity proof checks.

# Source identity registry gateway boundary

The identity-registry routes in `graph-worker-broker.ts` are disabled unless a
deployment injects `GraphWorkerBrokerDeps.identityRegistry`. They do not read a
catalog row, a named entity, prepared CFO text, or any caller-supplied authority.
They require the authenticated CFO caller to match the configured current
finance-run binding, then recheck that binding and active-run state around source
and store operations.

The source owner must provide one configured adapter per registry with:

1. A fixed authority descriptor and the fixed CFO run binding.
2. An automatic extractor that emits records from an authoritative source version.
   Each resolved record needs a stable `source_record_id`, source-document version,
   source SHA-256, exact mention, and an explicit identifier with namespace, scope,
   and value recorded by that source. A name-only match is an unresolved candidate,
   never a verified identity.
3. A currentness callback for the exact source version. The gateway calls it before
   and after publication, and the exporter calls it before and after signing.
4. An immutable snapshot store that rejects a second publication of a version and
   returns `active`, `missing`, or `revoked` for each pinned version.
5. The deployment-owned Ed25519 public key. The private signing key remains with
   the signer adapter and is never accepted by the gateway.

Source-bound candidate relationships can be retained and queried independently of
this registry. They must retain their source citation and mention identity, and must
not be promoted to a verified entity link without the explicit scoped identifier.

An old signed snapshot is still cryptographically valid after publication, but it
is not automatically authorized forever. The store's current `revoked` status is
authoritative. `GET /snapshots/:version` returns HTTP 410 for a revoked version.

Run the synthetic, no-network wire proof after compiling the gateway:

```powershell
& '.\\node_modules\\.bin\\tsc.cmd' -p tsconfig.json
node tools/identity-registry-wire.mjs ..\\.tmp-source-identity-registry-20260908
```

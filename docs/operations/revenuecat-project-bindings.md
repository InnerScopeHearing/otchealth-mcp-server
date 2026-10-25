# Project-scoped RevenueCat bindings

The legacy `REVENUECAT_API_KEY` remains the default credential for unscoped project listing,
unmapped projects and legacy v1 subscriber operations. Do not replace it to repair a different app.

For an approved app, set `REVENUECAT_PROJECT_KEY_ENV_JSON` to a JSON object mapping its exact
RevenueCat project ID to a secret environment-variable name. The names must match
`REVENUECAT_PROJECT_KEY_[A-Z0-9_]+`. Values in this mapping are names, never credentials.

The AWARE configuration uses project `proja2cc4776` mapped to `REVENUECAT_PROJECT_KEY_AWARE`.
The existing protected source reference is `/otchealth/revenuecat-aware-secret-key` in SSM.
Inject that reference through the ECS task definition's `secrets` field. Never copy its value
into task environment configuration, this document, source control, logs or a handoff.

Mapped project operations require a present syntactically valid secret key and fail before
upstream access if the mapping is malformed or its key is missing/invalid. They never fall back
to the fleet default key. Project-scoped v2 operations in all three clients use this resolver.

## Developer boundary

Developer retains the twelve project/catalog metadata readers and gains only the existing
product, offering, package and entitlement create/update handlers. These eight writes require
an explicit configured project credential at the execution boundary, including cached/internal
and canonical alias calls. No delete, customer, subscriber, price, refund, entitlement grant/revoke
or subscription-administration operation is included. Entitlement definition creation retains
its high-risk classification, high-risk switch, role gate and default preview behavior.

CTO gains the twelve metadata readers on its default connector for verification. Other lane
surfaces and explicit connector overrides retain their previous meaning. This is not a claim
that existing native clients have refreshed their callable definitions.

## Release and acceptance

Require exact-source CI and independent review. Build the gateway once at the merged commit,
verify its immutable ECR digest, then copy the current ECS task configuration with only reviewed
image/revision metadata and the new reference/mapping changed. Preserve all existing secret
references, roles, networking, capacity, write switches and the fleet default key. Keep the
previous task definition available as the documented rollback target.

Confirm service stability and the live gateway revision. Then have the existing Developer
client read the exact AWARE project and approved catalog metadata through its own binding.
Preserve a separate default-project-list receipt to show the default connection was not replaced.
Do not infer valid provider permissions from SSM metadata, a successful deploy, a catalog or a
dry-run preview. Catalog business changes and purchase/device acceptance remain separate work.

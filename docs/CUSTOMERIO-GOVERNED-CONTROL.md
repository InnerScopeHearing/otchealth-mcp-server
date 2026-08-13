# Customer.io governed control plane

Status: source-complete, credential-gated. The legacy App API and Track API remain separate from the newer Journeys UI API control plane.

## Authentication split

| Surface | Base | Credential | Gateway env |
|---|---|---|---|
| App API | `https://api.customer.io/v1` | App API bearer | `CIO_APP_API_BEARER` |
| Track API | `https://track.customer.io/api/v1` | Site ID plus Track key | `CIO_SITE_ID`, `CIO_TRACK_KEY` |
| Journeys UI API | `https://us.fly.customer.io/v1` | Long-lived `sa_live_`/`sa_sandbox_` service-account token exchanged for a one-hour JWT | `CIO_FLY_SERVICE_ACCOUNT_TOKEN` |

The service-account token is optional and fail-closed. When absent, the 42 `cio_admin_*` wrappers return a configuration error while the existing App/Track surface keeps working.

Canonical secret custody is Azure Key Vault `kv-otc-55c84f6bef`:

- `cio-app-api-bearer` -> Container Apps local secret `cio-app-bearer`
- `cio-site-id` -> local `cio-site-id`
- `cio-track-key` -> local `cio-track-key`
- proposed `cio-fly-service-account-token` -> local `cio-fly-service-account-token`

No value belongs in source, logs, tool arguments, or documentation.

## Official contract baseline

The implementation was checked against Customer.io's unauthenticated OpenAPI 3.1.0 document at `https://us.fly.customer.io/v1/openapi.json` on 2026-08-09:

- 760 paths
- 1,006 operations
- SHA-256 `d8de4902a7b6d23d162f7b5ed411724bceacc5ac23b9fea67e113d6ed6975218`

Customer.io's CLI documentation confirms the same service-account exchange and schema-driven API model:

- https://docs.customer.io/ai/cli/get-started/
- https://docs.customer.io/ai/cli/reference/
- https://docs.customer.io/ai/cli/service-accounts/

This release intentionally adds named, bounded wrappers rather than a generic 1,006-operation proxy.

## Access contract

- Read tools: `cto`, `cro`, and `exec` only.
- Write dry-runs: `cto`, `cro`, and `exec`.
- Live writes: `cto` and `exec` only.
- Every write is `write_orchestrated`, defaults to `dry_run=true`, requires high-risk tools enabled, and requires `owner_approval_ref` when `dry_run=false`.
- CRO is intentionally preview-only for writes.
- No wrapper sends messages, activates campaigns, writes profiles, changes suppressions, changes lists, or touches billing.
- Audit-log outputs redact sensitive request/response/payload/customer/actor fields with deterministic SHA-256 fingerprints.
- Design-readiness output never returns raw email HTML or full URLs.

## Read tools (20)

1. `cio_admin_read_workspace_health`
2. `cio_admin_read_workspace_health_view`
3. `cio_admin_read_frequency_caps`
4. `cio_admin_read_frequency_cap_usage`
5. `cio_admin_read_message_limits`
6. `cio_admin_read_preserve_unsubscribes_on_merge`
7. `cio_admin_read_goals`
8. `cio_admin_read_goal`
9. `cio_admin_read_goal_data`
10. `cio_admin_read_subscription_center_settings`
11. `cio_admin_read_subscription_topics`
12. `cio_admin_read_subscription_topic`
13. `cio_admin_read_subscription_channels`
14. `cio_admin_read_subscription_languages`
15. `cio_admin_read_subscription_language`
16. `cio_admin_read_subscription_pages`
17. `cio_admin_read_subscription_order`
18. `cio_admin_read_open_tracking_consent`
19. `cio_admin_read_audit_logs`
20. `cio_admin_read_design_readiness`

## Write tools (22)

1. `cio_admin_write_frequency_cap_create`
2. `cio_admin_write_frequency_cap_update`
3. `cio_admin_write_frequency_cap_delete`
4. `cio_admin_write_message_limits_update`
5. `cio_admin_write_preserve_unsubscribes_on_merge`
6. `cio_admin_write_goal_create`
7. `cio_admin_write_goal_update`
8. `cio_admin_write_goal_delete`
9. `cio_admin_write_subscription_center_settings`
10. `cio_admin_write_subscription_topic_create`
11. `cio_admin_write_subscription_topic_update`
12. `cio_admin_write_subscription_topic_delete`
13. `cio_admin_write_subscription_channel_upsert`
14. `cio_admin_write_subscription_channel_delete`
15. `cio_admin_write_subscription_languages_create`
16. `cio_admin_write_subscription_language_update`
17. `cio_admin_write_subscription_language_delete`
18. `cio_admin_write_subscription_page_create`
19. `cio_admin_write_subscription_page_update`
20. `cio_admin_write_subscription_topic_order`
21. `cio_admin_write_subscription_channel_order`
22. `cio_admin_write_open_tracking_consent`

## Design-readiness limitation

The schema exposes Design Studio email/template reads, render/preview, link-status checks, accessibility transformer settings, and inbox-preview resources. It does not expose a schema-backed SpamAssassin or spam-score endpoint. `cio_admin_read_design_readiness` therefore returns an explicit `spam_status.status=not_available` rather than inventing a call or sending content to an external scanner.

## Service-account provisioning

If `cio-fly-service-account-token` does not exist, an account administrator must create it in Customer.io:

1. Customer.io -> Account Settings -> Service Accounts.
2. Create system service account named `OTCHealth Gateway Admin Read + Draft`.
3. Assign a custom least-privilege role that can read workspace health, frequency caps/usage, message limits, merge policy, Goals, subscription-center configuration, environment consent settings, workspace audit logs, and Design Studio email/template metadata; it may create/update/delete only frequency caps, message limits, merge policy, Goals, subscription-center configuration, and open-tracking consent. Exclude Send, Execute/activate, profile/customer writes, suppressions, lists, billing, service-account administration, and sensitive-data access.
4. Create one non-expiring token for this system service account.
5. Store the value in Azure Key Vault `kv-otc-55c84f6bef` as `cio-fly-service-account-token` without placing it in chat or source.
6. Bind it to Container Apps local secret `cio-fly-service-account-token` and env `CIO_FLY_SERVICE_ACCOUNT_TOKEN` through the normal blue-green release path.

Until step 6 completes, the wrappers remain inert by design.

---
name: intercom-fin-operations
description: Safely operate OTCHealth's Intercom administration and Fin runtime tools. Use when an authorized COO/CTO task requires inspecting or changing an Intercom configuration, content object, or Fin invocation.
---

# Intercom and Fin Operations

This playbook guides use of the live tool schemas. It does not grant Intercom scopes, roles, plan entitlements, or permissions.

## Establish caller and target

1. Probe the actual connected role and workspace before acting. Use the caller's own Brain/catalog and identity. Do not infer a COO seat from tool visibility or infer a workspace from prior conversation. If role, identity, or target is unclear in the authenticated context, stop before a write.
2. Resolve the exact workspace and region from authenticated metadata/configuration. API 2.17 hosts are US api.intercom.io, EU api.eu.intercom.io, and AU api.au.intercom.io. Never switch by guess. Fin Agent API/MCP region coverage differs; verify the specific connection.
3. Use only fixed-endpoint operation discovery. Find the smallest relevant operation and request its schema on demand. Catalog visibility is not proof of authorization. Do not load the full OpenAPI schema at startup.

## Read, change, verify

4. Read current metadata/state first using the default metadata projection. Prefer IDs, status, counts and timestamps; avoid customer records and request/response bodies. If the operation, schema, or entitlement is unclear, stop and report the gap.
5. Separate read and write paths. For writes, confirm the exact business action is authorized by the user's task and caller role. Preview/dry-run where supported, check target IDs and fields, then make only the smallest explicit change. Catalog visibility and a successful dry-run do not grant approval. Never retry writes automatically.
6. Read the exact target back and compare it with the requested result. Report operation, target, outcome and provider rejection without exposing credentials or customer content. Retain enough before-state metadata to roll back a reversible change, and only roll back within the original authorized action.
7. For a control without a mapped API operation, use only a genuinely authenticated owner UI session with the exact workspace visible. Dashboard-only controls need their own UI verification. Public health checks and generic browser sessions do not prove administrator access. Without an authenticated owner session, leave state unchanged and report the gap.

## Keep Fin separate

Use intercom_fin_operation_catalog, intercom_fin_operation_schema and intercom_fin_operation_invoke only for Fin runtime work. Use the general intercom_operation_* family for allowed administration/configuration. Fin is customer-facing: invoke only the selected intended action/procedure for the explicit request, with minimal approved inputs/output. Treat every POST/invocation as a write and apply dry-run/role gates where available. Never expose the internal admin/Brain catalog, admin metadata or broad reporting to Fin. Never place admin credentials/provider tokens in Fin prompts or payloads.

Intercom is not the source of truth for payment, fulfillment, subscription or warranty state. Read those facts from the owning system or its explicitly authorized business-action tool.

## Data boundaries and evidence

Do not move PHI, credentials, personal legal matter content or MNPI across the Fin/customer boundary. Avoid raw request/response bodies and unprojected conversation/export content when metadata answers the task. Honor caller scope and data minimization even if a credential could return more.

The supporting inventory is official Intercom REST API 2.17: 182 paths, 258 operations, 45 tag groups; SHA-256 cc0bc82f24a3237a3a1d6eb3adc64e1a5c0b84ad43e88faec5a6c8afe9e7e6b8. See references/coverage.md for the complete operation crosswalk location and limits. A documented method does not prove tenant scope, role, plan, entitlement, or UI parity. This skill does not install tools, connect a workspace, or confer access.

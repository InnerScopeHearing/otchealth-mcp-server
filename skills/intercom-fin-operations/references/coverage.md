# Intercom/Fin operation coverage and access

## Source and complete crosswalk

Source: official Intercom API 2.17 OpenAPI bundle, SHA-256 cc0bc82f24a3237a3a1d6eb3adc64e1a5c0b84ad43e88faec5a6c8afe9e7e6b8, 2,059,912 bytes. It contains 182 paths, 258 HTTP operations and 45 tag groups. The complete row-level mapping for all 258 operations (method, exact path, operation ID, summary and tag) is references/API-OPERATIONS.csv (packaged with this skill); the source bundle is the official public download at https://developers.intercom.com/_bundle/docs/references/@2.17/rest-api/api.intercom.io.json?download. Use those artifacts as the operation crosswalk; resolve the exact method/path/schema from the row and versioned spec before relying on an operation. They do not prove tenant scope, role, plan, feature availability or live state. Do not copy the full schema into agent startup.

The operation inventory groups coverage across contacts/users/leads (including bulk jobs, subscriptions, notes, tags, banners, segments and associations); companies; conversations (search, replies/notes, assignment, state, tags and merge); tickets and ticket types; articles/internal articles/snippets/folders/collections/redirects; AI content sources and external pages; tags, audiences and attributes; custom object instances; admin/current-admin/away/activity; team reads/metrics; macros; workflow export; calls; messages/email/WhatsApp; events/jobs/exports/reporting; office-hour schedules/exceptions; IP allowlist; Fin runtime; and visitors. The CSV is the exact per-operation map; the groups here are an index, not a substitute for endpoint schemas.

## Important documented boundaries

| Area | 2.17 evidence | Limit |
|---|---|---|
| AI knowledge content | CRUD for content import sources and external pages; articles and Help Center content families | Does not prove complete Fin behavior/policy authoring. Branding, domain, themes and full Help Center settings are not established. Content source sync behavior cannot switch to/from API. |
| Data Connectors | Create/list/retrieve/delete/PATCH, versions and execution results; connector PATCH schema includes draft/live state | Read schema and state first. Result details may contain request/response bodies; use a safe projection. Live changes need explicit authorization, preview and readback. |
| Fin runtime | Seven /fin operations: start, reply, CSAT, capabilities, ask, procedure run, escalate | Runtime is not Fin administration or complete procedure authoring. Keep customer-facing invocation separate from internal configuration. |
| Office hours | Ten schedule/exception CRUD methods | Check timezone, exact object, effective window and rollback metadata. |
| Audiences | List/create/read/update/delete /audiences | Does not prove saved-segment rules or campaign targeting configuration. |
| Reporting | Async export jobs, status, dataset discovery/download, activity and event surfaces | Exports can be broad/sensitive. Request only authorized datasets/attributes and return minimal or aggregate output. |
| IP allowlist | GET and PUT | One security setting is programmable; this does not mean all security is programmable. |
| Admins, teams, macros, workflows | Admin reads and away-mode; team list/read/metrics; macros list/read; workflow export | Team membership/roles, macro edit, workflow create/update/publish are not in this production 2.17 inventory. Preview docs are not production contract evidence. |
| SSO, billing, role/permission administration and broader settings | No complete write mapping established by reviewed 2.17 inventory | Mark each control unmapped/unverified. Use an authorized owner UI only when authenticated access is genuinely available. |
| Customer records and conversations | Many CRUD/search/reply/state operations exist | Sensitive data and customer-visible actions. Use existing authorized role surfaces; do not make the admin wrapper a generic data API. |
| Commerce and fulfillment | No Intercom system-of-record guarantee | Payment, order, subscription and warranty state comes from the owning service or an explicitly authorized business-action tool. |

## Gateway tools

The planned names are intercom_operation_catalog, intercom_operation_schema, intercom_operation_read and intercom_operation_write for fixed documented administration operations; and intercom_fin_operation_catalog, intercom_fin_operation_schema and intercom_fin_operation_invoke for isolated Fin runtime operations. Treat names/availability as unverified until the deployed registry and actual caller schema confirm them. Catalog/schema are discovery helpers, not a universal proxy. Do not route customer/contact/conversation/ticket/event operations through a new config wrapper unless that exact approved scope is added. Keep existing scoped tools intact.

## Adoption and acceptance checklist

1. Root/CTO verifies deployed revision, image digest, health and registered schemas, retaining the documented rollback image. Source code or a catalog row alone is not deployment evidence.
2. Confirm the actual COO identity/Brain and exact target workspace from the authenticated lane. Keep it distinct from CTO catalog access or another role's seat.
3. Confirm the planned tools are visible to that COO caller and inspect their current schemas. Discover exact operations on demand.
4. Under explicit business authorization, perform a metadata-only read. Separately, if explicitly authorized, perform one low-impact reversible write using preview/dry-run and exact readback. Record read and write acceptance separately. A visible catalog or 72 registered gateway tools does not prove working access.
5. For unmapped controls, require an authenticated owner UI with the exact workspace visible, plus preview and readback. Without this, leave the setting unchanged and report the gap.
6. Keep Fin tools/data minimal and customer-facing. Do not expose the internal admin/Brain catalog. Do not claim other chats or agents adopted automatically; adoption requires each caller's own availability, identity and access evidence.

## Supported distribution/access paths

- Private ChatGPT plugin: callable Plugin Creator capabilities include private plugin create, owned-plugin listing/inspection and update. The supported flow accepts a completed local package in the authenticated active workspace or personal account. It can carry skills and connect to a verified existing MCP server. Saving a plugin does not deploy the server, connect every user's identity or prove Intercom access. Root must package the finished skill and verified gateway endpoint, inspect the saved plugin, then verify with the actual COO seat. No plugin was created or published by this work.
- Codex repository skill: install both skill files under .agents/skills/intercom-fin-operations/ in the target maintained repository. Root must commit via repository owner workflow, confirm the COO Codex uses that repository, and verify the deployed tools are callable. A file in a repository does not bind a server or grant provider permissions.
- Current result: local source files only. No plugin save, repo adoption, Brain change, provider/customer call or Intercom UI write occurred. Root owns commit, deployment, plugin packaging/publication and live COO acceptance.

## Current dispatch boundaries

The launch maps all258 operations:149 administration operations enabled,102 customer/identity/bulk or other operations held behind their owning scoped tools, and7 Fin runtime operations enabled as explicit writes. Verify current catalog before use. An enabled schema is not tenant entitlement or proof of a live write. All Fin POSTs can have effects, including capabilities creating/updating a supplied user. Existing Intercom token_ids are opaque references; vault/env strings are not a credential loader.

# Isolated Xero source runtime configuration

Live source handoff task `9195998341344614a6cdbbd99bfb3bf2`, definition revision4, exited1 on gateway image a62d048. Diagnostic run34719174938 returned fixed code `xero_organisation_source_handoff_unavailable`. No raw financial records or credentials were returned.

Code review found that the source-owner launch copies only Xero and PostgreSQL settings, but the actual Xero client called the gateway-wide `loadEnv()`. That schema requires three unrelated Customer.io settings. The existing PostgreSQL state plane already uses a dedicated runtime reader, so no data-plane change was necessary.

Three fresh-process synthetic tests reproduced startup failures with the source-owner environment before this change. The Xero client now uses a reader limited to its existing ten Xero settings. All organization identifiers, optional tenant pins, default empty values, token rotation, durable token writes, and role checks remain in their existing paths. The gateway-wide configuration schema is unchanged. No Customer.io credentials are copied into the source worker.

After the change, the fresh-process tests initialize the actual Xero client with only synthetic Xero and PostgreSQL settings. Missing Xero client or bootstrap credentials still report unconfigured. The existing Xero client and tool suites also passed:74 tests total, no skips. TypeScript no-emit compilation passed.

This fixes a reproduced prerequisite failure. A new image and fresh source handoff run are required to establish live success; other downstream failures are not ruled out by this report.

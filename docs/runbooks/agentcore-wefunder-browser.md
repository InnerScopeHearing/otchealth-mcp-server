# AgentCore Browser for Wefunder Campaign Director

## Current boundary

This gateway surface is public-read-only by default. It validates exact allowlisted HTTPS URLs and returns only redacted receipts. It does not log in, persist browser state, edit the Wefunder campaign, publish, send invitations, communicate with investors, accept investment, change terms, handle payments, KYC, accreditation, banking, tax forms, or e-signatures.

## Why this exists

A saved Hyperagent skill card documents the workflow but does not create a callable browser runtime. The gateway tool supplies the executable, audited control point. The Wefunder AgentCore profile stays isolated to the Wefunder Campaign Director role and permits one active session lease.

## Deployment

The provider is disabled unless ENABLE_AGENTCORE_WEFUNDER_PUBLIC_READONLY=true. AWS credentials must be supplied only through Azure Key Vault-backed Container Apps secret bindings using a dedicated, least-privilege runtime identity. The gateway source contains only environment-variable names; it never reads or emits credential values.

The code intentionally does not create an AgentCore session until a separately reviewed transport implementation verifies the current AWS Browser API, region quota, IAM action set, cost envelope, and audit/retention behavior. This is deliberate: guessing the API from discovery endpoints could accidentally create a billable profile or browser.

## Authentication and mutations

Authentication, MFA, saved profile state, and all campaign or investor actions require separate explicit owner approval. An approval to authenticate does not approve a mutation. Each external or irreversible action requires its own approval.

## Wefunder Campaign Director procedure after deployment

1. Call browser_agentcore_wefunder_preflight with 1-12 exact public HTTPS targets and intent public read-only inspection.
2. Only if preflight succeeds and the browser inspection tool is visible, call browser_agentcore_wefunder_inspect_public with the same targets and a maximum duration of 300 seconds.
3. Treat only the returned redacted host, status, title, final host, timestamp, and cleanup receipt as output. Do not request HTML, screenshots, login, drafts, profiles, cookies, editing, publishing, messaging, investment actions, or any account/session persistence.
4. If the tool reports disabled, unconfigured, busy, or a hard gate, stop and send CTO the receipt. Do not retry through the native browser or substitute a different provider.

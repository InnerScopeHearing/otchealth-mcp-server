# AgentCore Browser for Wefunder Campaign Director

## Current boundary

This gateway surface is public-read-only by default. It validates exact allowlisted HTTPS URLs and returns only redacted receipts. It does not log in, persist browser state, edit the Wefunder campaign, publish, send invitations, communicate with investors, accept investment, change terms, handle payments, KYC, accreditation, banking, tax forms, or e-signatures.

## Why this exists

A saved Hyperagent skill card documents the workflow but does not create a callable browser runtime. The gateway tool supplies the executable, audited control point. The Wefunder AgentCore profile stays isolated to the Wefunder Campaign Director role and permits one active session lease.

## Deployment

The provider is disabled unless ENABLE_AGENTCORE_WEFUNDER_PUBLIC_READONLY=true. This change intentionally ships without a transport adapter or credential plumbing; enabling the flag alone returns a safe adapter-unconfigured result. A later CTO-reviewed change must add the Key Vault-backed AgentCore transport, then prove a single public read-only request before any authentication work is considered.

## Authentication and mutations

Authentication, MFA, saved profile state, and all campaign or investor actions require separate explicit owner approval. An approval to authenticate does not approve a mutation. Each external or irreversible action requires its own approval.

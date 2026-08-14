# AgentCore Browser Broker

The broker is the fleet-wide browser control plane for `otchealth-mcp-server`.

## Enrollment model

A browser action is authorized only when the calling agent is present in `enrollment.ts` and its requested capability is explicitly granted. Each enrollment has a stable isolated profile label and target-host policy. Unknown callers fail closed.

The first enrollment is `wefunder-campaign-director`, initially with `public_read` for Wefunder and OTCHealth public surfaces. The older Wefunder-named bridge remains available during migration; new agent enrollment should use the broker tools.

## Capability progression

- `public_read`: public navigation and redacted receipts.
- `authenticated_read`: requires a dedicated identity/profile and explicit credential-use approval.
- `draft_write`: supports reversible drafts only after an enrolled workflow is implemented.
- `committed_write`: supports external effects only after action-specific approval, a durable audit record, idempotency, and verification.

The current AgentCore transport implements only `public_read`. Adding a capability requires an implementation, a narrow enrollment change, tests, CI, deployment, and the relevant approval gate; the broker is not a mechanism for ambient credentials or universal unrestricted control.

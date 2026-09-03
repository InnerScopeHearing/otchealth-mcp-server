---
name: otchealth-gateway-rails
description: Gateway-specific security and correctness rails for otchealth-mcp-server. Use when reviewing a pull request that changes ring or lane gating, a per-connector or per-agent tool catalog, OAuth/connector scoping, or a call to an OpenAI- or Bedrock-family LLM.
---

# OTCHealth gateway review rails

This repo is the fleet's MCP gateway. Its ring gating and per-lane tool
catalogs are the security boundary between an unauthenticated or
low-privilege caller and privileged company data (finance, legal,
PHI-adjacent, credentials). Treat any change that touches this boundary as
security-sensitive, never as routine.

## Ring gating and per-lane toolsets

- A connector or agent "lane" (for example an external read-only lane
  versus an internal exec-ring lane) must only ever see the tool catalog it
  was scoped to. Adding a new tool to the codebase does not automatically
  make it safe to expose on every lane. When a PR adds a privileged tool,
  secrets or credential admin, financial writes, legal or privileged
  document access, destructive commerce actions, outbound sends, or raw
  memory writes, check that it is excluded from external and low-privilege
  lanes, ideally with a test that pins the exclusion.
- External lanes (a public or low-trust connector) must never gain access
  to a privileged tool as a side effect of a refactor, a shared base
  tool-list change, or a default-allow change. If a diff changes how a
  lane's tool set is computed, ask for the before/after tool count and set
  for at least one external lane and one privileged lane.
- Give a change to OAuth client provisioning, token lanes, or connector
  registration the same scrutiny: a bug here can mint a privileged token
  for what should be a read-only connector.

## LLM provider calls

- When a call requests JSON output through a `json_object` (or equivalent)
  response-format mode, the literal word "json" must appear somewhere in
  the prompt sent to the model. Omitting it is a provider-level error for
  that mode, not a style issue (this exact bug has shipped and been fixed
  in this repo before). Flag a new or edited JSON-mode call whose prompt
  text does not contain "json".
- Models in the gpt-5.6 family reject a `temperature` parameter. A call
  that targets a gpt-5.6-family model must not set `temperature`; flag it
  if it does, since the call will error rather than silently ignore the
  parameter.

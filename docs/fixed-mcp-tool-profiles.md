# Fixed MCP tool profile endpoints

The gateway exposes fixed MCP presentation profiles at:

- `POST /mcp/profile/read-only`
- `POST /mcp/profile/engineering`

Clients select a profile by configuring one endpoint URL for the MCP connection. The route binds
the same profile to every stateless MCP POST, including `initialize`, `tools/list`, and
`tools/call`. The server does not inspect task headers, query parameters, JSON-RPC arguments, or
model text to choose a profile. Unknown profile paths return 404.

The read-only profile starts from the existing 13-tool external read-only baseline. The engineering
profile starts from that baseline and adds the bounded GitHub engineering set for authenticated
`cto` and `developer` seats. Both are maximum presentation sets only. Registration still intersects
the selected profile with the authenticated seat's existing connector allowlist and optional lane
curation. A profile cannot grant a capability that those existing filters remove.

Every handler keeps its existing role, ring, write, dry-run, and confirmation checks. For example,
the engineering profile can advertise `github_create_branch` to an eligible seat, while the handler
continues to enforce the caller role and the normal `dry_run` and warning acknowledgement inputs.
Hidden tools are not registered on that endpoint, so a direct `tools/call` for one is rejected by
the MCP server. The baseline still includes catalog metadata tools, so a profile is not a
confidentiality boundary and should not be treated as one.

The existing `POST /mcp` route retains its current behavior. It does not inherit a profile from a
separate endpoint configuration. No client settings are changed by this server feature.

## Client compatibility acceptance

Endpoint support is not proof that a client keeps the selected profile across reconnects or repeats
it for every stateless request. Before treating a client as accepted, capture its real
`initialize`, `tools/list`, and `tools/call` requests against the same configured profile URL, verify
the authenticated seat and connector identity, try a direct call to a hidden tool, and confirm the
normal write prompts and handler gates. Repeat this for each supported client and seat. This server
change does not establish that ordinary ChatGPT, Codex remote, Hyperagent, or other clients pass
that live trace.

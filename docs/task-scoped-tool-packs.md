# Task-scoped MCP tool packs

Authenticated clients can opt into a smaller advertised tool set with an
explicit **x-otc-task-class** HTTP header on **/mcp** requests.

| Header value | Advertised pack |
| --- | --- |
| Missing, repeated, malformed, or unknown | The existing authenticated caller catalog is unchanged |
| read_only | The 13-tool read-only baseline, intersected with the caller's existing registration filters |
| engineering | The read-only baseline plus the bounded GitHub engineering pack for authenticated cto and developer seats, intersected with the caller's existing registration filters |

The gateway is stateless. Send a recognized header on every /mcp POST,
including initialize, tools/list, and tools/call, to apply a task pack. An
omitted or unrecognized value preserves the existing caller catalog so older
clients do not silently lose their lane-specific tools.

The header only selects tool visibility. The bearer token is authenticated
first, and caller_agent remains derived from that token. Connector and lane
catalog filters still run before the task pack. Handler role and ring checks,
dry_run, acknowledge_warning, and the existing write gates remain in force.
The engineering pack excludes merges, workflow dispatch, privileged knowledge,
legal-document tools, memory writes, and business-system mutations.

# Task-scoped MCP tool packs

Authenticated clients can select a smaller advertised tool set with the
**x-otc-task-class** HTTP header on **/mcp** requests.

| Header value | Advertised pack |
| --- | --- |
| read_only, missing, repeated, malformed, or unknown | The 13-tool read-only baseline, intersected with the caller's existing registration filters |
| engineering | The read-only baseline plus the bounded GitHub engineering pack for authenticated cto and developer seats, intersected with the caller's existing registration filters |

The gateway is stateless. Send the header on every /mcp POST, including
initialize, tools/list, and tools/call. If a request omits it or sends an
unrecognized value, that request receives the read-only pack.

The header only selects tool visibility. The bearer token is authenticated
first, and caller_agent remains derived from that token. Connector and lane
catalog filters still run before the task pack. Handler role and ring checks,
dry_run, acknowledge_warning, and the existing write gates remain in force.
The engineering pack excludes merges, workflow dispatch, privileged knowledge,
legal-document tools, memory writes, and business-system mutations.

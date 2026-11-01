# Developer Git read pilot

The gateway exposes a read-only Git smart-HTTP route for the authenticated Developer lane and the
single `InnerScopeHearing/iheartest` repository. It permits only upload-pack discovery and fetch;
it does not provide receive-pack, Git pushes, arbitrary repositories or Git LFS. The route uses
the gateway's existing GitHub App installation token, which stays in the gateway process. That
existing token has the App installation's permissions and is not itself narrowed by this route.

Only an Authorization bearer header is accepted. Browser-origin requests, alternate roles,
unsupported queries and unexpected paths are rejected. Caller headers are not forwarded to
GitHub. The route rejects redirects and relays only Git's expected response media types. Per
replica, each caller is limited to two concurrent operations and ten starts per minute; the route
also bounds total concurrency, request and response sizes, idle time and total time. A limit can
interrupt an unusually large or slow fetch; clients must treat an interrupted fetch as incomplete.

The Dell-side client must keep the Developer bearer out of arguments, logs and repository config,
disable Git tracing and redirects, and skip LFS smudging. The endpoint does not itself provision
client credentials or configure a Git remote. Use a separate task-owned checkout or mirror for a
first live test; do not overwrite existing work. GitHub App installation access to the repository
and end-to-end GitHub connectivity require independent live verification.

Rollback is to deploy a prior verified gateway image and stop using this route. The existing GitHub
MCP tools and their write/protected-content gates are separate and unchanged.

# Tool reliability observability

These observations are diagnostic metadata, not permission grants or proof that another Chat has loaded a schema. Existing authentication, provider calls, deadlines, queue limits, result-cache exclusions and browser enrollment remain authoritative.

## Request and tool linkage

MCP requests retain their existing generated correlation ID. Tool start/end records optionally add `mcp_request_correlation_id`, separate from the per-tool `correlation_id`. Missing or malformed parent IDs are omitted. Fixed `tool_phase_timing` observations carry bounded durations and closed phase/outcome labels; successful requests use a deterministic 10% sample by parent request, while non-success observations are retained. No arguments, result bodies, URLs, credentials or arbitrary provider error text belong in these phase events.

The AWS bridge observes queue, credentials, initialization, operation and best-effort shutdown separately. A timeout after dispatch has unknown effect, not confirmed failure or success. Shutdown timing is not evidence that the upstream session was destroyed. Never automatically replay an unknown write.

## Results and discovery

Eligible ordinary inline results add content-free UTF-8 byte observations without parsing or serializing the payload again. Offload, retrieval, binding, expiry and fail-open behavior remain unchanged. Ephemeral outputs, terminal result retrieval, AWS bridge results, WeFunder investor outputs and M365 static-auth outputs retain their existing exclusions. An offloaded result still requires retrieval; a returned preview does not prove task completion.

The discovery evaluation is synthetic helper coverage. Metadata bytes and helper calls are measured; actual host-loaded tool tokens, input/output tokens, deferred loading, first valid model call and business-task completion are unknown unless the host supplies receipts. Task folders and routing instructions do not themselves shrink the schemas already loaded by a client.

## Scanner failures

`browser_file_scanner_failure` records a closed stage/reason, bounded duration and `outcome: quarantined`. Signature age appears only when a valid past timestamp was obtained. Scanner errors still return the generic error verdict and never release an unscanned file. These log events use the existing logging sink; their presence does not prove alert delivery or notification deduplication.

## Client acceptance and recovery

Probe each authenticated role using that role's own `catalog_probe`. Compare its gateway revision, caller-surface fingerprint and required bindings with its accepted state. Present, installed, advertised, queued and exercised are distinct states. The WeFunder catalog no longer advertises the three chat-action bridge tools that its handler denies; this does not remove its separately authorized company-browser bindings.

Classify failures before repair: local connector-schema rejection; missing binding; provider authentication; host approval; tunnel rate limit; service error; result offload. Backend deployment cannot repair a host's already-loaded schema. Use a supported integration-specific Refresh control at most once, then verify a harmless invocation in that same affected client. If no such control is exposed, retain the exact owner UI dependency; do not disconnect healthy accounts, mint credentials or claim another Chat refreshed.

Roll out only a changed, reviewed immutable image after required CI and both-platform runtime acceptance. Preserve the previous immutable image and service configuration. Monitor transitions, not repeated unchanged blockers. Retention, desktop idle behavior, scanner freshness, notification delivery and actual browser-stack cost require their own observations; configuration alone is not operational acceptance.

---
applyTo: "**"
---
# Security & ring instructions (auto-applied to every file)
- Never hardcode or log secrets, tokens, API keys, or PHI. Secret scanning + push protection are ON.
- Keep changes minimal and atomic; run lint + tests before opening/updating a PR.
- Prefer the governed OTCHealth MCP gateway (https://mcp.otchealth.app) for fleet tools.
- Never touch the medreview repo or move PHI/MNPI/attorney-privileged data to non-BAA services or external clients.

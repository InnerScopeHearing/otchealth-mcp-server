# Perplexity Build Spec (Original Mega-Prompt)

This is the original Perplexity-authored build spec, preserved verbatim. Claude Code reads this as the Phase 1 tool surface, security, and deliverables authority.

For architecture, tech stack, and tool routing decisions, ADR-001 takes precedence over this document.

---

You are in build mode, not advisory mode.

Your job is to design, build, test, and document a production-ready remote MCP server for OTCHealth's stack, with Customer.io as the first-class connector and the rest of the stack added in a clean phased architecture.

Current date: May 11, 2026.
Time sensitivity: high.
Environment reality: you have access to n8n, Customer.io credentials, and the rest of the OTCHealth stack through our internal vaults and existing automation environment. Do not stop at planning. Build the first working version.

Primary goal:
Create a custom remote MCP server that Perplexity can add as a custom connector, so Perplexity can directly use OTCHealth tools through our own MCP server instead of depending on Composio for core workflows.

Top priority:
1. Customer.io
2. Shopify
3. Intercom
4. n8n
5. Notion
6. Optional: ElevenLabs, Twilio, Gmail, Google Sheets if easy to expose safely

Non-goals:
- Do not build a generic demo MCP.
- Do not write a speculative design doc without implementation.
- Do not use Composio for the core path if direct APIs exist.
- Do not hardcode secrets in code, docs, or logs.
- Do not create any connector that exposes write access without explicit allowlisting and audit logging.

==================================================
SECTION 1: REQUIRED OUTCOME
==================================================

Build a production-ready MCP server with:

A. A remotely hosted HTTPS endpoint suitable for Perplexity custom remote connectors.
B. MCP-compatible transport. Prefer Streamable HTTP or HTTP+SSE if easiest and compatible, but use a real MCP implementation, not an ad hoc REST wrapper pretending to be MCP.
C. Customer.io tool coverage for the core operational workflows we actually need.
D. Authentication and authorization that protects all secrets server-side.
E. Structured audit logging.
F. A clean README and operator handoff doc.
G. End-to-end tests proving Perplexity could use it.
H. Phase 2 scaffolding for Shopify, Intercom, n8n, and Notion.

Perplexity custom connectors require a remote MCP server URL, not raw API keys. Build the MCP wrapper accordingly.

==================================================
SECTION 2: STACK FACTS YOU MUST RESPECT
==================================================

Customer.io:
- Use direct API, not Composio, for core functionality.
- Workspace ID: 193366.
- US region only.
- App API base: https://api.customer.io/v1/...
- Track API base: https://track.customer.io/api/v1/...
- App API auth is bearer token.
- Track API auth is HTTP Basic using site ID + track key.
- Customer.io App API supports newsletters, segments, and newsletter metrics. UI remains authoritative for some create/update/delete workflows, so do not assume full CRUD for everything.
- Avoid EU endpoints.

n8n:
- We already use n8n heavily.
- Prefer n8n for rapid integration where appropriate, but do not force the MCP server itself to be "pure n8n" if a small Node server is cleaner.
- If deploying n8n webhooks behind reverse proxy, ensure WEBHOOK_URL and N8N_PROXY_HOPS=1 are configured correctly.
- Reuse existing n8n workflows where smart, but do not create a spaghetti dependency graph.

Perplexity:
- This connector must be addable as a custom remote connector in Perplexity.
- Therefore the final output must be a real remote MCP server over HTTPS with stable auth and transport.

Brand/Legal:
- OTCHealth is one word.
- TReO is a Personal Sound Amplifier, never a hearing aid.
- MatriX has HearAdvisor grade B, never A.
- OTCHealth and InnerScope own zero patents.
- MatriX 510(k) belongs to Soundwave LLC, not OTCHealth.
- Be careful not to expose regulated or investor-sensitive data casually.
- Matt is a public-company CEO, so include a risk note if any tool could expose Reg FD sensitive data.

==================================================
SECTION 3: REQUIRED ARCHITECTURE DECISION
==================================================

ADR-001 has already made this decision. See ADR-001.md.
Decision: Option C (Hybrid).

==================================================
SECTION 4: PHASE 1 TOOL SURFACE, CUSTOMER.IO FIRST
==================================================

Build Phase 1 with Customer.io as the best-supported integration.

Expose these MCP tools at minimum:

READ TOOLS:
1. list_newsletters
   - Inputs: optional limit, cursor, created_after, created_before
   - Returns: newsletter ids, names, status, timestamps

2. get_newsletter
   - Inputs: newsletter_id
   - Returns: full newsletter metadata, subject variants if available, segment/audience reference, schedule metadata

3. get_newsletter_metrics
   - Inputs: newsletter_id
   - Returns: delivered, opens, prefetch opens if available, clicks, unsubscribes, bounces, complaints, link metrics, variants if available

4. get_newsletter_schedule
   - Inputs: newsletter_id
   - Returns: authoritative send schedule info, including original_scheduled_at if available

5. get_segment
   - Inputs: segment_id
   - Returns: name, type, size if available, description/rules if exposed

6. list_segment_people
   - Inputs: segment_id, limit, cursor
   - Returns: paginated people identifiers and key fields

7. get_customer
   - Inputs: email or customer_id or phone
   - Returns: profile, attributes, segment membership if available

8. get_broadcast_history_for_segment
   - Inputs: segment_id, trailing_days default 90
   - Returns: newsletters/broadcasts likely sent to that segment with performance metrics

9. get_template_or_content
   - Inputs: newsletter_id and/or content_id/template_id if supported
   - Returns: HTML/body, preheader, subject variants, links, image refs
   - If Customer.io API does not expose this cleanly, implement best-effort retrieval and explicitly document the limitation.

WRITE TOOLS, GUARDED:
10. update_newsletter_variant
   - Inputs: newsletter_id, variant_id or content_id, fields allowlisted to subject, preheader, body_html, from_name, reply_to, send_at
   - Must support dry_run=true by default
   - Must write audit log with diff
   - Must reject disallowed fields

11. duplicate_newsletter
   - Inputs: source_newsletter_id, new_name
   - Returns: duplicated entity if supported, otherwise fail cleanly with "UI-only"

12. track_event
   - Inputs: identifier, event_name, data
   - Uses Track API
   - Allowlist event names if possible

13. update_customer_attributes
   - Inputs: identifier, attributes
   - Uses Track API identify/update path
   - Write audit log

Important:
- For all write tools, implement an allowlist and "safe mode" switch.
- The first deployed version can be read-heavy and write-light. That is acceptable.
- Never fake support for endpoints that are UI-only. Detect and return "unsupported_via_api".

==================================================
SECTION 5: PHASE 2 TOOL SURFACE, REST OF STACK
==================================================

After Customer.io Phase 1 is working, scaffold these integrations:

Shopify:
- get_product
- list_products
- get_product_analytics_snapshot
- list_abandoned_checkouts
- create_draft_order
- get_order
- get_product_page_html
- Eventually: update_product_copy with strict allowlist

Intercom:
- search_help_center
- search_conversations
- get_conversation
- list_articles
- get_article
- tag_conversation or create_internal_note only if safe

n8n:
- list_workflows
- get_workflow
- get_execution
- trigger_webhook
- get_recent_failures
- set_workflow_active only if explicitly allowlisted and audited

Notion:
- search_pages
- get_page
- query_database
- create_page in a designated ops database only

Optional:
ElevenLabs:
- get_agent
- update_agent_prompt only through explicit allowlist and diff logging
Twilio:
- get_phone_config
- update_phone_routing only if explicitly enabled

==================================================
SECTION 6: SECURITY REQUIREMENTS
==================================================

You must implement serious security. This is not optional.

1. Secrets:
- Load all secrets from environment variables or secret manager.
- Never print secrets into logs.
- Never commit secrets.
- Never store raw vault exports in repo.

2. Auth for MCP server:
- Require authentication from Perplexity side using API key or OAuth if practical.
- At minimum, support a strong bearer token and IP/rate controls.

3. Authorization:
- Separate read tools from write tools.
- Add per-tool authorization classes if feasible.
- Add env switches:
  - READ_ONLY_MODE=true/false
  - ENABLE_WRITE_TOOLS=true/false
  - ENABLE_HIGH_RISK_TOOLS=true/false

4. Audit logging:
- Log every tool call with timestamp, tool name, caller identity, sanitized inputs, outcome, latency.
- For writes, store before/after diff where feasible.
- Include a correlation ID.

5. Validation:
- Strong JSON schema validation on every tool.
- Reject unexpected fields.
- Prevent arbitrary pass-through HTTP requests.

6. Data minimization:
- Do not return more PII than the tool needs.
- Mask email/phone in logs.
- Redact secrets from error objects.

7. Risk control:
- Add a "regulated_data_guardrail" module.
- If a request tries to expose investor-sensitive, FDA-sensitive, or credential-like content, require explicit override or return a warning.

==================================================
SECTION 7: DEPLOYMENT REQUIREMENTS
==================================================

Deploy this as a real service, not just local dev.

Preferred stack:
- Node.js + TypeScript
- Official MCP SDK if available and mature enough
- Express/Fastify if needed for HTTP integration
- Dockerized
- HTTPS behind reverse proxy
- Health check endpoint
- Structured JSON logs

Deployment targets, in order of preference:
1. Existing OTCHealth infrastructure if available
2. Railway / Render / Fly / small VPS
3. Cloud Run or similar

Must include:
- /health endpoint
- MCP endpoint
- CORS/origin policy if required by MCP client
- Reverse proxy config notes
- Example env file without secrets
- Rollback notes

If any part uses n8n webhooks:
- Document the webhook URL and auth model
- Ensure proxy and webhook URL configuration is correct

==================================================
SECTION 8: TESTING REQUIREMENTS
==================================================

You must actually test it, not assume it works.

Minimum tests:

Unit / schema tests:
- Input validation for every Customer.io tool
- Auth rejection
- Safe-mode rejection on writes
- Unsupported endpoint behavior

Integration tests:
- list_newsletters returns live data from workspace 193366
- get_newsletter on a known newsletter works
- get_newsletter_metrics returns metrics for a known newsletter
- get_segment works on known segment id if accessible
- track_event works against a designated test contact or designated test event name
- update_newsletter_variant only in dry_run first, with diff output

Manual test script:
- Connect from an MCP-capable client
- Call list_newsletters
- Call get_newsletter on a live newsletter
- Call get_newsletter_metrics
- Confirm response quality
- If write tools enabled, run one dry-run update and inspect audit log

Perplexity-readiness test:
- Provide exact remote connector URL
- Provide expected auth method
- Provide one tool invocation example phrased as a natural language query:
  "Show me newsletter 8 and its last metrics"
- Confirm the tool surface is usable enough for real investigation

==================================================
SECTION 9: DELIVERABLES
==================================================

At the end, produce these deliverables:

1. Running MCP server
2. Source repo
3. README with:
   - architecture
   - setup
   - env vars
   - security
   - deployment
   - connector setup in Perplexity
4. Tool catalog with schemas
5. Test results
6. Known limitations
7. Phase 2 roadmap
8. Short operator playbook:
   - how to rotate secrets
   - how to disable write tools
   - how to inspect logs
   - how to revoke a connector
9. One short note for Matt:
   - what is live now
   - what is safe now
   - what is still risky

==================================================
SECTION 10: EXECUTION STYLE
==================================================

You are not allowed to stay at the whiteboard.

Execution sequence:
1. Inspect what credentials and API docs are already available internally.
2. Decide architecture. (ALREADY DONE in ADR-001)
3. Build the server.
4. Implement Customer.io read tools first.
5. Test them against live data.
6. Add guarded write tools.
7. Deploy.
8. Produce docs.
9. Only then suggest next improvements.

When blocked:
- State the exact blocker
- Show the exact command, endpoint, or credential class missing
- Propose the smallest fix
- Continue

Do not end with abstract recommendations.
End with:
- live endpoint
- enabled tools
- test results
- next safe action

==================================================
SECTION 11: CUSTOMER.IO-SPECIFIC IMPLEMENTATION NOTES
==================================================

Important implementation notes for Customer.io:
- Newsletter metrics endpoints exist and include translations/A/B metrics according to docs.
- Segments and people-in-segment are supported.
- Some updates to newsletter variants are supported, but many lifecycle create/update actions remain UI-driven. Detect, don't assume.
- Use the App API for newsletters, segments, and metrics.
- Use the Track API for identify/event operations.
- Prefer read-first reliability over write breadth.
- If template HTML retrieval is awkward, expose a tool that returns the best available content model and explicitly state whether HTML came from API, cached render, or unsupported path.

==================================================
SECTION 12: SUCCESS CRITERIA
==================================================

This project is successful only if:
- Perplexity can add the remote connector
- At least 5 Customer.io tools work against live workspace data
- At least 1 guarded write path works in dry-run mode
- Audit logging exists
- Secrets stay server-side
- The result is documented well enough that another engineer can maintain it

Now begin. Build the first working version.

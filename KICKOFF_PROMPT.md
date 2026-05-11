# Claude Code Kickoff Prompt

## How to use this file

In Claude Desktop, click the **Code** tab (top of window), open a new session on this folder, then paste everything between the two markers below as your FIRST message.

`.env.example` is already populated with Matt's Customer.io credentials. You only need Claude Code to generate three random tokens and produce the final `.env` file. No manual credential entry from you.

---

(===START COPY HERE===)

You are building a production-grade remote MCP server for OTCHealth. The architecture is already decided. The full tool spec is already written. Your job is to execute, not re-plan.

READING ORDER (mandatory):
1. Read `ADR-001.md` FIRST. This is the locked architecture decision. Do not propose alternatives.
2. Read `PERPLEXITY_SPEC.md` SECOND. This is the tool surface, security, and deliverables spec.
3. Read `.env.example`. It contains Matt's live Customer.io credentials (pulled from his Notion Token Vault, last rotated 2026-05-07).

CONFLICT RESOLUTION:
Where ADR-001 and PERPLEXITY_SPEC conflict, ADR-001 wins on architecture, tech stack, and tool routing. PERPLEXITY_SPEC wins on tool surface scope, security requirements, and deliverables list. If you find a genuine conflict not covered by these rules, ask Matt before deciding.

EXECUTION PLAN (do not deviate without flagging):

==================================================
STEP 0: Generate secrets and finalize .env
==================================================

Three secrets need values that are NOT yet in .env.example:
- PERPLEXITY_CONNECTOR_TOKEN
- ADMIN_REVOKE_TOKEN
- N8N_WEBHOOK_SECRET

Generate each as 32 random bytes hex-encoded. Use Node:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Or use the integrated terminal in this Code session.

Then: copy `.env.example` to `.env` and write the three generated values into the matching slots. The Customer.io values are already in place.

The Notion Token Vault is at: https://www.notion.so/35220e2667bc81e2b591fb1f641473f8

After generating the three tokens, ask Matt for permission to add them back to the Notion vault under a new section titled "OTCHealth MCP Server (added [today's date])". If Matt approves, write them to Notion. If he says skip, save them only to .env locally.

For N8N_API_KEY (needed in Step 5) and the GitHub PAT (needed in Step 6), do NOT load now. Pull them from the Notion vault at the moment each is needed. If you cannot reach Notion, ask Matt to paste the relevant section from the vault page.

Confirm to Matt: ".env populated, three new tokens generated, ready to proceed to Step 1." Then continue.

==================================================
STEP 1: Scaffold the project
==================================================
- Initialize package.json with the locked tech stack (Node 20, TypeScript strict, official MCP SDK, Fastify, Zod, Pino)
- Create tsconfig.json with strict mode and ES2022 target
- Create Dockerfile (multi-stage build)
- Create src/ directory structure: src/auth, src/audit, src/compliance, src/customerio, src/tools, src/n8n, src/server
- Initialize git, .gitignore is already in place

==================================================
STEP 2: Build core infrastructure
==================================================
- Customer.io API client (App API bearer auth + Track API basic auth)
- Auth middleware (bearer token validation, SHA256 hash of caller token logged, never raw)
- Audit logger (Pino structured JSON, correlation IDs, before/after diffs for writes)
- Schema validation layer (Zod, reject unexpected fields)
- Compliance guardrail middleware per ADR Section 10
- Kill-switch admin route (POST /admin/revoke) per ADR Section 6

==================================================
STEP 3: Implement Phase 1 READ tools per ADR Section 4a
==================================================
All 9 read tools must work end-to-end against Customer.io workspace 193366 before moving on:
- cio_list_newsletters
- cio_get_newsletter
- cio_get_newsletter_metrics
- cio_get_newsletter_schedule
- cio_get_segment
- cio_list_segment_people
- cio_get_customer
- cio_get_template_or_content (best-effort, return unsupported_via_api on failure)
- cio_get_broadcast_history_for_segment

Every tool gets: Zod input schema, outputSchema, structuredContent in response, MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint), actionable error messages.

==================================================
STEP 4: Implement Phase 1 simple WRITE tools
==================================================
- cio_track_event (Track API)
- cio_update_customer_attributes (Track API)
Default to dry-run mode. Idempotency key support.

==================================================
STEP 5: Implement orchestrated WRITE tools via n8n
==================================================
- cio_update_newsletter_variant
- cio_duplicate_newsletter
Export n8n workflow JSON to /n8n-workflows/ for version control.
Pull n8n API key from Notion vault (or ask Matt to paste n8n section).

==================================================
STEP 6: Deploy to Railway
==================================================
- Push to GitHub (account: GBGolfMatt). Pull GitHub PAT from Notion vault when needed.
- Connect Railway, deploy with env vars from .env
- Confirm /health endpoint returns 200 over HTTPS
- Confirm MCP endpoint reachable
- Default first deploy: READ_ONLY_MODE=true

==================================================
STEP 7: Build Phase 4 evaluations
==================================================
10 read-only questions per ADR Section 8. Output to /evals/phase1.xml.

==================================================
STEP 8: Provide Matt the Perplexity connection details
==================================================
- Exact connector URL
- Auth method (bearer token = PERPLEXITY_CONNECTOR_TOKEN)
- One example natural-language query to test
- Where to paste the connector token in Perplexity (Settings, Connectors, Add custom connector, Remote)

DELIVERABLES (per PERPLEXITY_SPEC Section 9):
- Live HTTPS endpoint
- Source repo with full source
- README with full operator playbook (rotate secrets, disable write tools, inspect logs, revoke connector)
- Tool catalog with schemas
- Test results
- Known limitations
- Short final note for Matt: what is live, what is safe, what is still risky

STYLE:
- Ship working in 24 hours, not perfect in two weeks
- Read-heavy first, write-light to start
- Hard gate: READ_ONLY_MODE=true on first deploy
- When blocked, state the exact blocker, the smallest fix, and continue

Start with Step 0: generate the three secrets, finalize .env, confirm with Matt before moving on.

(===END COPY HERE===)

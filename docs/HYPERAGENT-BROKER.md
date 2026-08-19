# Hyperagent broker

Connects every Claude agent lane to its corresponding Hyperagent agent, through this gateway, with
per-lane ring gating that Hyperagent itself cannot express.

## Why a broker, and not one connection per agent

The obvious design — give each Claude agent its own Hyperagent MCP connection — does not work, and
the way it fails is worth stating precisely because it *looks* like it works.

Hyperagent supports Dynamic Client Registration, so you **can** register a separate OAuth client per
agent. Six clients, six independently revocable tokens. But the scopes carry no agent dimension:

```
scopes_supported: threads:read  threads:write  approvals:read  approvals:write  offline_access
```

and the vendor documentation states it plainly:

> "A connected client gets no access you don't already have. It can only reach the agents you can."

So six connections are **six keys to the same building**. Every one of them can read every thread on
the account, including the CLO's (attorney-privileged, a live California family matter involving
minors) and the CFO's (MNPI). Per-agent connections would multiply the credential exposure surface
while providing zero separation — and would present as isolation on the org chart.

There is also a hard mechanical constraint. Hyperagent advertises:

```
grant_types_supported: ['authorization_code', 'refresh_token']
```

**No `client_credentials`.** A server cannot authenticate itself. Every connection is user-delegated
through a browser consent, which means a scheduled job or a headless session can never establish one
on its own.

The broker resolves both problems at once. `offline_access` yields a refresh token, so **one** human
consent produces a credential the gateway can use indefinitely — the identical pattern already in
production for OneDrive (`graph-onedrive-refresh-token`, which exists because that tenant blocks
app-only auth). The gateway then decides, per caller lane, which Hyperagent agent may be addressed.

## Architecture

```
Claude agent (lane = cto | cfo | clo | developer | ...)
      │  authenticates on its existing gateway lane, no new consent
      ▼
otchealth-mcp-gateway
      │  src/tools/hyperagent/ring.ts   ← authorization decided HERE
      │  one delegated credential
      ▼
https://hyperagent.com/api/mcp
```

## Authorization model

Two independent conditions must **both** hold before a lane may address an agent:

| | Mechanism | Config |
|---|---|---|
| 1 | The lane is explicitly **assigned** that agent id | `HYPERAGENT_LANE_AGENTS` |
| 2 | The lane is inside the agent's **classification ring** | `HYPERAGENT_AGENT_CLASSES` |

Requiring both is deliberate. The allowlist alone would let one env-var edit hand `cto` a CFO agent.
The ring alone would let any exec-ring lane reach every exec agent whether or not it was assigned
one. Together, widening access takes a deliberate change in two places.

**Classification and rings:**

| Class | Reachable by |
|---|---|
| `personal-legal` | `clo-personal`, `exec` |
| `exec` | `cfo`, `clo`, `clo-personal`, `cpo`, `cco`, `exec` |
| `general` | any authenticated lane |
| `unknown` | **nobody** |

`cto` is deliberately in **neither** privileged ring, matching `kb_search_privileged`. It is the
broad, externally-reachable connector identity, so keeping it out of privileged data caps the blast
radius of the most widely-connected lane at no operational cost.

### Deny-by-default is the point

An agent that nobody classified is `unknown`, and `unknown` reaches nobody. The real Hyperagent agent
ids live on Matt's account and were not knowable at build time, so the safe landing spot for anything
unmapped had to be refusal. Guessing toward permissive is how a privileged thread leaks.

The same principle runs through the parsing: a malformed `HYPERAGENT_LANE_AGENTS` entry is dropped
rather than interpreted as a wildcard, and a misspelled class (`genral`) is dropped rather than
coerced to `general`. A typo must never widen access.

### The forced-pattern backstop

Name fragments (`clo-personal`, `cfo`, `legal`, `mnpi`, `wefunder`, `investor`, …) force a
classification regardless of the configured map, so mapping a CFO agent to `general` by mistake still
refuses it.

**`wefunder` / `investor` / `reg-cf` were added only after reading the real agent list.** The account
holds "Wefunder Campaign Director" and "Wefunder Investor Focus Group", and neither matched any
original pattern — both would have defaulted to reachable by every lane. That is Reg CF securities
material, where the standing rule is attorney-and-owner gated, so a broadly readable default was
exactly wrong.

The general lesson is worth more than the two names: **this backstop can only be calibrated against
the actual agent list, never guessed from the design.** Re-run `hyperagent_list_agents` and re-check
the classification whenever agents are added.

**Ordering matters and is pinned by a test:** `clo-personal` is checked *before* `clo`, because
"clo-personal" also contains "clo". Reversing those two blocks would silently downgrade the most
sensitive surface in the fleet to the merely-executive ring.

### Fetch, check, then return

For anything addressed by `threadId` rather than `agentId`, the thread is fetched, its owning agent
resolved, the ring checked, and **only then** is content returned. Never return-then-check.

If the owning agent cannot be determined, the call is **refused**, not served. An undeterminable
owner is the one case where guessing has an unbounded downside.

`hyperagent_list_threads` and `hyperagent_list_agents` **omit** what a lane may not reach rather than
refusing the whole call, so a privileged agent's *name* never leaks either. An authorization failure
that still discloses the name of a privileged matter is a smaller leak, not a non-leak.

## Tools

| Tool | Category | Gating |
|---|---|---|
| `hyperagent_list_agents` | read | filtered to the lane's visible set |
| `hyperagent_create_thread` | write_orchestrated | ring-checked on `agentId` |
| `hyperagent_get_thread` | read | fetch → resolve owner → ring-check → return |
| `hyperagent_send_message` | write_orchestrated | ring-checked via owning agent |
| `hyperagent_list_threads` | read | filtered; undeterminable owners omitted |

Writes are ring-checked as strictly as reads. Writing into a privileged thread puts this lane's
content in front of readers it does not control, which is at least as bad as reading one.

## Configuration

| Variable | Purpose |
|---|---|
| `HYPERAGENT_CLIENT_ID` | OAuth client id (DCR-registered) |
| `HYPERAGENT_CLIENT_SECRET` | Only if a confidential client; public DCR clients have none |
| `HYPERAGENT_REFRESH_TOKEN` | Captured once from the browser consent, `offline_access` scope |
| `HYPERAGENT_LANE_AGENTS` | `cto=ag_1,ag_2;cfo=ag_3` — a lane absent here reaches nothing |
| `HYPERAGENT_AGENT_CLASSES` | `ag_1=general;ag_3=exec` — an agent absent here is `unknown` |

Unset ⇒ every tool returns `mode: unconfigured` and explains what is missing. The broker is inert,
not broken, until the consent lands.

### Refresh-token rotation: confirmed real, and now handled durably

This was written as a conditional ("if Hyperagent rotates…"). On 2026-08-18 it was tested against the
live service and **it rotates on every use**. Access tokens last ~15 minutes, so at the live replica
count each replica refreshes several times an hour.

The original design kept the rotated token **in memory**, which fails two ways:

1. Replica A rotates; replica B is still holding the token A just consumed.
2. Any redeploy drops both replicas back to the configured value, which is spent.

And the penalty is not a retry. Under RFC 9700 reuse detection, presenting a consumed token can
revoke the **entire token family**, which costs a fresh human browser consent.

So rotation moved to `src/tools/hyperagent/token-store.ts`, which persists every rotation to the
shared agent-state store under an **ETag'd compare-and-swap, before the token is used**:

- an in-process mutex serializes refreshes *within* a replica; the ETag covers *across* replicas
- a 412 loser **adopts the winner's chain** and never persists its fork
- a failed persist **refuses to return the token** rather than let the next caller reuse a spent one
- `invalid_grant` writes an ETag'd tombstone (which can never clobber a live winner) and raises
  `HyperagentNeedsConsentError`, naming the human step
- the stored chain is stamped with a hash of the configured bootstrap token, so storing a fresh
  consent supersedes a dead chain automatically, with no redeploy

This is deliberately **the same shape as `src/tools/xero/client.ts`**, whose refresh tokens are
single-use for the same reason and which has already been through the incidents this one has not. A
second, subtly different rotation implementation would be strictly worse than a familiar one.

**Fail-closed:** if the shared store is unconfigured, the broker refuses to run rather than rotating
unsynchronized. Losing the Hyperagent tools for a while is far cheaper than burning the token family.

## Layer 2: defense in depth

Two halves. Being precise about which is delivered:

**Half one — gateway-side enforcement. DELIVERED.** Even though the broker credential is
account-wide, this gateway refuses to route any lane to a privileged agent. That holds today,
independent of anything configured on the Hyperagent side, and is pinned by 13 tests.

**Half two — Hyperagent-side account separation. REQUIRES MATT, and is partly unresolved.**
Hyperagent Teams have owner/member roles, and members "get the working setup without seeing the rest
of the owner's personal workspace." So privileged agents (`clo-personal`, `cfo`) could live outside
the brokered account entirely, meaning even a compromised broker credential could not reach them.

Three things must be answered before that can be built, and **none of them can be determined from
the documentation** — they are support questions:

1. Can one organisation hold multiple Hyperagent logins/accounts?
2. Is a Team member's MCP connection genuinely scoped to shared agents only? (Implied by the Teams
   documentation, never stated **for MCP specifically**.)
3. What are the rate limits? Undocumented.

Until those are answered, half one is the operative protection — and it is sufficient on its own for
the threat it addresses, because our broker is the only path from a Claude lane into Hyperagent.

## Bring-up

1. **Matt:** register the client and complete the browser consent once, with `offline_access`.
2. Store `hyperagent-client-id`, `hyperagent-refresh-token` (and a secret if confidential).
3. Run `hyperagent_list_agents` from an exec lane to read the **real** agent ids.
4. Populate `HYPERAGENT_AGENT_CLASSES` for every returned agent. Anything left out stays `unknown`
   and is unreachable — verify that is what you intend for each one.
5. Populate `HYPERAGENT_LANE_AGENTS` to map each lane to its counterpart agent.
6. Verify the refusals, not just the successes: confirm a `cto`-lane call to a `cfo`-classified agent
   is refused, and that `hyperagent_list_agents` from `cto` omits privileged agents by name.

Step 6 is the one that matters. A broker that returns data proves the happy path; only a refusal
proves the gate.

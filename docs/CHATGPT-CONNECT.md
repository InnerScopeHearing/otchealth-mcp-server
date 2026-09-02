# ChatGPT / Claude URL-only connect, with owner-code role elevation

ChatGPT and Claude custom connectors connect to `mcp.otchealth.app` by pasting the gateway URL
alone — no client ID, no client secret, no manual credential entry. Under the hood this is Dynamic
Client Registration (RFC 7591) plus authorization-code + PKCE (see `src/server/oauth.ts`'s file
header for the full OAuth 2.1 mechanics). Every connector that connects this way is, by default,
bound to the `external-read` lane: read-only, non-privileged, the fix for the July 2026 P0 where a
connector's self-chosen name used to be trusted to pick a lane (see `oauth.ts`'s "Part 6" comment).

This document covers the piece on top of that default: an **interstitial consent page**, shown by
the gateway itself mid-flow, that lets the owner (Matt) type in a short-lived setup code and connect
a URL-only connector as a privileged role instead — `cto`, `cfo`, `clo`, `coo`, `cro`, or
`developer`. The pattern mirrors what Sentry (`mcp.sentry.dev`), Cloudflare, and Linear all do for
the same problem: the auth server, not the connecting client, decides what a connection is allowed
to become, and it decides that from something only the owner holds.

## The owner flow

1. Ask the CTO (or an `exec`-lane agent) to mint you a setup code for the role you want — see
   "The operator flow" below. They will hand it to you privately (Slack DM, in person, a password
   manager entry — never a shared channel or a ticket).
2. In ChatGPT or Claude, add a custom connector and paste `https://mcp.otchealth.app/mcp` (or
   whatever the gateway's public URL is). Click Connect.
3. You land on a page titled **"Connect to the OTCHealth gateway."** It has one text field and two
   buttons:
   - **Elevate with owner code** — type the code exactly as given (dashes optional, case doesn't
     matter) and click this button.
   - **Connect read-only instead** — click this with no code typed, if you just want the
     non-privileged default.
4. If the code is right, you are redirected back to ChatGPT/Claude and the connection completes —
   as the elevated role, from then on, for as long as the connection stays alive (including across
   token refreshes; see "How elevation survives a refresh" below).
5. If the code is wrong, the SAME page reappears with a plain "invalid or expired" message. You get
   five tries before the page gives up entirely and you have to start over from step 2 with a fresh
   code.

That's it — there is no role picker on this page. The code itself already says which role it grants;
typing it is the only decision the page asks you to make.

## The operator flow (minting a code)

Call the gateway tool `connector_setup_code_create`. It is restricted to the `cto` and `exec`
lanes — anyone else calling it gets a plain `forbidden_role` refusal, whether or not the role they
asked for was valid.

```json
{
  "role": "cfo",
  "label": "cfo connector on Matt's ChatGPT",
  "ttl_minutes": 30
}
```

- `role` — one of `cto`, `cfo`, `clo`, `coo`, `cro`, `developer`. **`clo-personal` is not a valid
  value and never will be** — there is no connector-elevation path to the attorney-privileged
  personal-legal ring, full stop (see `src/auth/setup-codes.ts`'s header for why).
- `label` — optional, for your own tracking (never shown to the connecting owner, never logged with
  the code itself).
- `ttl_minutes` — optional, defaults to 30, capped at 1440 (24h). Keep it short; the whole point of
  a short window is that a code sitting unused in a chat log stops being redeemable on its own.

The tool's result contains the **plaintext code, exactly once** — it is never recoverable after this
call returns; the stored record only ever holds a SHA-256 hash of it. Deliver it to the owner
privately. Do not paste it into a group channel, a GitHub issue, a PR description, or anything else
that outlives the one conversation it belongs in.

A code is single-use: the moment it is redeemed, it is permanently spent, whether the redemption
succeeds or (if somehow re-submitted afterward) fails. Minting a second code for the same person/role
is always safe and does not affect the first one.

## What the code is (and isn't)

The code is a 16-character value from a 32-symbol alphabet that deliberately excludes visually
ambiguous characters (`0`/`O`, `1`/`I`/`L`), shown grouped as `XXXX-XXXX-XXXX-XXXX` for easy reading
and typing. That's 80 bits of entropy — guessing it by brute force is not a realistic attack at any
practical rate limit, which is why the five-attempt budget below exists to catch typos and
occasional wrong guesses, not to be the thing standing between an attacker and the role itself.

The code is **not** a general-purpose credential. It cannot be used anywhere except this one consent
page, it cannot be redeemed more than once, and it expires on its own even if nobody ever tries it.

## Why this can't reopen the self-mint hole

The July 2026 P0 happened because a connector's **client-supplied** name was trusted to pick a
privileged lane. This feature does not repeat that mistake, because nothing the connecting client
supplies — its name, its `client_id`, its `redirect_uri`, the text of a wrong code guess — has any
influence on which role (if any) gets granted. The two facts that jointly decide the outcome are:

1. **Does this exact code exist, unused, and unexpired?** — resolved entirely from a record this
   gateway itself created and keyed by the code's own hash, never from anything the request claims.
2. **What role was it minted for?** — fixed the moment an already-`cto`/`exec`-authenticated caller
   minted it, and never adjustable afterward by anyone, including the person redeeming it.

The connecting client never even sees the code unless the human on the consent page chooses to type
it in on the client's behalf — the client's own OAuth flow has no field for it at all.

## How elevation survives a refresh

A subtlety worth knowing if you're debugging a connection that "loses" its privileged role after a
few hours: the elevated role is baked into the refresh token's own signed claims at the moment of
elevation, and every subsequent refresh trusts that claim rather than re-deriving the connector's
lane from its (permanently `external-read`) registration record. This is a deliberate fix, not an
oversight — see `src/server/oauth.ts`'s comment on the `refresh_token` grant for the mechanics. If a
connection ever DOES revert to read-only unexpectedly, that is a bug, not expected behavior.

## Confidential connectors are unaffected

None of this changes how an already-provisioned confidential client (an `occ_...` client entered
directly into Claude's Advanced connector settings, or a `client_credentials` connection used by
Claude Code / Hyperagent) behaves. Those clients already carry a real, Matt-provisioned secret and a
fixed lane; they skip the consent page entirely and complete exactly as they always have.

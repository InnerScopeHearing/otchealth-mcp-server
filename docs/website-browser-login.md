# Company website browser login

The cloud browser runs in the existing AWS AgentCore service. Each of the seven company lanes can browse public websites with its own public-web profile. Persistent website profiles are separate, bound to the authenticated OAuth authorization, the agent lane, and the selected website policy.

## Sign in and resume

### Existing clients with a saved tool list

If a company chat can call `browser_cloud_session_start` but has not loaded the newer login tool names, use the existing input schema:

```json
{"profile_id":"website-login:linkedin","max_seconds":600,"dry_run":false}
```

Use `website-login:wefunder` for the campaign portal. These are two explicit named profiles, not an arbitrary command or URL dispatcher. They invoke the same OAuth-bound human-login service and retain the existing tool confirmation and company-owner checks. They are not a fallback around an explicit workspace action denial or approval requirement.

The result includes the real `sessionId`, provider session `expiresAt`, actual saved `profile_id`, short-lived `login_url`, separate `login_expires_at`, and `status: "human_login_required"`. Display the link immediately and keep it out of shared memory. Requested login duration must be 1–3,600 seconds; optional `action_budget` must be 1–10,000. After Done, start an ordinary new session with the returned real profile ID and verify authentication.

Both existing profile-discovery tools return non-secret `website_profiles` entries: the named `login_profile_id`, owned `saved_profile_id` if present, and `saved_profile_available`, `login_required`, or `unavailable`. Discovery creates no provider profile or session. A saved profile is not proof the website is currently authenticated. Ordinary public-profile fields and normal session starts are unchanged.

Custom sites continue to use the newer explicit login tool below. Updating the server cannot itself republish a workspace app's saved action list: use the owning app's supported action review/Refresh/publication controls for new tool names. Do not reset existing chats or sign-ins.

### Current explicit login tools

The viewer requires an explicit AgentCore control transfer, not merely a successful video connection. Setup prepares and suppresses the owned session, confirms `UpdateBrowserStream` with automation `DISABLED`, and only then grants human access. Exchange repeats that check for an unconsumed ticket. Done confirms automation `ENABLED` on the same session, persists its validated automation endpoint, then verifies and saves while output remains suppressed. A failed or mismatched transfer cannot report a usable handoff or a saved login. The gateway task role needs `bedrock-agentcore:UpdateBrowserStream` on the exact built-in browser ARN; this does not grant another connection's session.

1. Call `browser_cloud_login_start` with `site: "wefunder"` or `site: "linkedin"`. For another public HTTPS website, use `site: "custom"`, the expected signed-in page `url`, and optional additional exact `allowed_hosts` needed for that site. Use a normal page address without a signed query, OAuth callback, token, or fragment.
2. Show the returned short-lived `login_url` to the owner immediately. Do not save that link in shared memory. The owner signs in inside the embedded browser, confirms the intended account, opens the requested page, and selects Done. Passwords and verification codes stay inside that browser.
   A reload in the same tab can resume its exchanged viewer only while the original ticket, cookie, browser session and profile lease remain valid. The tab stores only a nonsecret handoff selector; the HttpOnly cookie authenticates resume. Reload never extends the sign-in deadline or replaces the browser. Done and resume are serialized, and an uncertain control transfer blocks further sign-in effects until owned recovery.
3. After the page reports a successful save, call `browser_cloud_session_start` with the returned `profile_id`. Read the requested website and verify the intended signed-in account. A saved profile alone does not prove authentication.
4. Use the normal session actions for navigation, forms, keyboard, tabs, scrolling, screenshots, PDF capture, and staged uploads. Save the profile after an intended change to persistent browser state, and stop sessions when finished.
5. A later chat with the same connection can find the profile with `browser_cloud_login_profile_discover`, using the same site/target configuration. Reopen and verify it again. A different OAuth authorization or agent does not inherit another connection's login.

Website profiles permit up to the provider's eight-hour session duration, with a configured 10,000-action mission budget and 120-second action timeout. New sessions can restore the saved profile. These are provider/workload bounds, separate from website verification, access permissions, account expiry, or MFA challenges.

## Human takeover and ownership

The `/browser/connect` viewer reuses the deployed Amazon DCV client. Each browser tab has its own one-time handoff and HttpOnly cookie. Tickets are durable, hashed, expiring, and single-use. A lease prevents overlapping sign-in writes to the same saved profile. Browser output and ordinary automation remain suppressed during human authentication; the login session is stopped before normal work resumes in a new session.

Preset completion checks the expected WeFunder editor or LinkedIn feed/profile. Custom completion checks the selected HTTPS origin and page path. All flows reject a remaining password form. The owner's Done action confirms the account; current authentication and role access still require a new-session readback.

The custom website resolver verifies public DNS destinations. This is a preflight, not an egress pin. Native `aws.browser.v1` has the same provider network assumptions as the existing Intercom login feature. The existing general public-web browser separately retains its configured custom browser and proxy policy.

## Connector rollout and acceptance

The browser lifecycle, file staging, and login tools are included for CTO, CFO, corporate CLO, COO, CRO, Developer, and WeFunder. The personal legal connection is not enrolled by this company rollout. Existing explicit connector catalogs cannot hide half of the browser workflow. A Chat client that caches an older schema must refresh its matching company app and verify the actual callable tool definitions.

Each existing chat must return its own evidence: inventory, public-page read, typed marker and clear, navigation/back, reload, screenshot retrieval, cleanup, human sign-in, profile save, and restored authentication. Record built-in desktop, local Edge, and cloud results separately. A code merge, deployment, another chat's browser, or a queue delivery receipt does not certify that chat.

## Project continuity

The takeover originates from local CTO chat `01a1406a-92ce-7da2-9858-da46daaec5fd`; current coordination chat is `01a14100-ce5e-7082-9e80-ea743397a015`. Work-ledger task: `t_idem_8e874614`.

Preserve the existing `WeFunder Campaign Main` chat `6acef375-f5e0-83e8-b8de-4c1333481967` and `LinkedIn Profile Optimization` chat `6ad0fa6e-ec60-83e8-98fc-6abdc9bf309c`. Historical parent desktop authentication did not reach both delegated chats. LinkedIn's own cloud browser subsequently passed general interaction but lacked a takeover viewer and saved authentication. The existing OpenAI support diagnostic is already escalated; do not create a duplicate support case.

The companion CTO recovery operation `grant-company-website-browser-profile` installs the narrowly scoped AgentCore profile permissions. Build and deploy the exact reviewed gateway source through the existing ECR and recovery workflows, then verify each serving replica and run client acceptance. Keep source-tested, merged, deployed, and authenticated-client acceptance as separate states.

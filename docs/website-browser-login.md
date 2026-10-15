# Company website browser login

The cloud browser runs in the existing AWS AgentCore service. Each of the seven company lanes can browse public websites with its own public-web profile. Persistent website profiles are separate, bound to the authenticated OAuth authorization, the agent lane, and the selected website policy.

## Sign in and resume

1. Call `browser_cloud_login_start` with `site: "wefunder"` or `site: "linkedin"`. For another public HTTPS website, use `site: "custom"`, the expected signed-in page `url`, and optional additional exact `allowed_hosts` needed for that site. Use a normal page address without a signed query, OAuth callback, token, or fragment.
2. Show the returned short-lived `login_url` to the owner immediately. Do not save that link in shared memory. The owner signs in inside the embedded browser, confirms the intended account, opens the requested page, and selects Done. Passwords and verification codes stay inside that browser.
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

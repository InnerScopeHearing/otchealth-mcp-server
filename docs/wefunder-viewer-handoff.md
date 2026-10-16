# WeFunder private viewer handoff

Operator and agent procedure for an owner completing WeFunder sign-in in the private in-app desktop. These instructions describe the intended workflow; they are not a deployment or live acceptance receipt.

## Start and prepare

Use the WeFunder Campaign Director connection and its existing `browser_cloud_session_start` binding with `profile_id: "daytona-desktop:wefunder"`, `max_seconds: 900`, and `action_budget: 40`. This uses the existing string `profile_id` input; no new tool binding is needed. Keep the returned session ID as the identifier for status and cleanup.

The handoff flow automatically creates and explicitly selects the real WeFunder editor before a viewer grant is issued. The owner should not have to locate a nested address bar. Once control passes to the human, do not issue browser automation actions against that session. The human completes only the intended security verification/sign-in/MFA and confirms the account; Campaign Main remains the sole campaign-draft writer after confirmed return.

Open the returned private viewer before its five-minute opening deadline. The viewer opening deadline and browser mission deadline are separate; the mission’s original deadline caps the entire handoff and cannot be extended by renewing a viewer grant.

## Recover or renew the same handoff

Keep the same browser profile and its secure recovery cookie, and retain the handoff ID in the page query. On reload, choose the page’s status or recovery action for that same handoff. Do not request another link or start a replacement mission to diagnose a viewer failure.

Renew only when the same mission is still eligible and the page explicitly offers renewal. Renewal revokes the previous viewer grant before minting another grant, and the new grant remains capped by the unchanged mission deadline. If renewal or recovery is uncertain, check status for the same handoff; do not replay the operation or transfer cookies to another browser.

## Finish and verify

Choose Done only after confirming the intended signed-in account and editor. Treat the operation as saved only when the response confirms all four fields: `status: "saved"`, `human_input_revoked: true`, `checkpoint_saved: true`, and `mission_released: true`. Cancel and `browser_cloud_session_stop` release/cancel a session; neither proves that login state was saved.

If the Done acknowledgement is lost, use the existing read-only `browser_cloud_job_get` with `job_id` set to the original Daytona session ID. It returns exact-owner mission lifecycle and receipt status. The owner may reconcile cleanup only from the same known persisted saved receipt; do not checkpoint again or claim success from an ambiguous response. A pending or unknown status is not a completion receipt.

After a confirmed handoff, start a fresh `daytona-company` session and verify the intended account and editor. Main remains the sole campaign writer and may save/reopen only the previously approved V9.1 private draft and its five highlights. Verify the reopened draft before reporting it saved.

Do not request an owner login until the actual in-app viewer has been exercised with harmless input and its load/recovery path checked. An Edge 429 or native host connection-close error is a separate host/browser issue; neither justifies a repeated link-issuance loop. Do not bypass security checks, transfer cookies, broaden permissions, or claim deployment, viewer acceptance, login, or draft save without the corresponding direct evidence.

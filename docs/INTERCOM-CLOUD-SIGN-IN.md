# Intercom cloud sign-in

The deployed operation gateway is separate from the browser account sign-in. The COO connection can use `browser_cloud_intercom_login_start` with the company owner's dashboard workspace ID and its exact allowed regional host. It returns a ten-minute, single-use link; the DCV connection is signed for five minutes. Credentials and MFA are entered in the provider window. The owner confirms the correct company and account on its Settings page before selecting Done.

Saved state is bound to a verified, per-authorization OAuth connection ID and exact workspace/region. Access and refresh tokens share that ID. A legacy token without the claim remains isolated using its validated bearer fingerprint until refresh upgrades the connection; its old profile is not silently reassigned. A shared OAuth client ID alone never binds human browser state.

Completion records owner confirmation plus an exact Settings URL/password-form check, saves the provider profile and stops the session. It is not an independent server-side claim of the person's Intercom identity. A subsequent owned browser start and Settings read are required for runtime acceptance. Persistent captures and all ordinary tool output/actions during sign-in are blocked. Tokens, cookies, profile contents and login URLs must not be copied to Brain or logs.

Profile creation requires `CreateBrowserProfile`, profile-backed start/save and `ConnectBrowserLiveViewStream` on the fixed US-east-1 AgentCore system browser and `cooIntercomAuth*` profiles. The matching reviewed recovery-console operation is `grant-intercom-browser-profile`, preview first and then apply, with exact task-role identity, prewrite fence, backup, readback and IAM simulation. It refuses root and missing authority. No new credential is required. If the existing recovery role lacks policy-maintenance scope, the prepared one-time AWSAdministratorAccess SSO helper grants only GetRole/GetRolePolicy/PutRolePolicy on the existing gateway task role.

Publication of this source alone does not prove that AWS grants, human sign-in, session reuse or the existing ChatGPT Dot tool bindings have passed. Live receipts remain separate.

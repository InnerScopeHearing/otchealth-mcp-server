# Always-on AWS access for company lanes

## Access model

The AWSCore interactive identity currently has a 12-hour session limit. This gateway path does not extend or reuse that identity. Its AWS MCP bridge uses the gateway ECS task role only to call STS, then signs AWS MCP requests with short-lived credentials from the pinned `otchealth-ai-reader-role`. Role chaining limits each assumed-role session to one hour. The gateway refreshes before expiry and resolves the task-role credentials again for each refresh; its in-process cache coalesces concurrent refreshes, reuses a still-valid reader session during a short STS outage, and fails closed when that session expires and STS remains unavailable.

Gateway OAuth is a separate caller-authentication layer. Its authorization-code and refresh-grant access tokens use `OAUTH_CC_TTL_SECONDS`, which defaults to 24 hours. The configured refresh-token lifetime defaults to 90 days, and each successful refresh issues another refresh token with a fresh lifetime. Refresh tokens are stateless signed JWTs: issuing a successor does not invalidate its predecessor. Active OAuth clients can renew access tokens without a new interactive sign-in while their refresh token remains valid. This gives the gateway a renewable caller session while its service and the OAuth client continue to operate. It does not establish an AWSCore session longer than 12 hours, nor does it prove uninterrupted production operation for any elapsed period.

The approved company lanes are CTO, Developer, CFO, COO, and CRO. AWS DevOps work uses the CTO lane; COO Hub work uses the COO lane. Each lane must be explicitly bound in the gateway's reviewed operator configuration. Caller input must never select an IAM role. The current reader role is shared because those lanes receive the same read-only permission set; CloudTrail session names identify gateway AWS sessions and are not per-human identity. If a lane needs different permissions, use a separately reviewed lane-to-role mapping and distinct least-privilege role rather than widening this shared role.

The reader role permits AWS metadata inspection through AWS MCP. Its policy is ViewOnlyAccess with explicit denies for secret and data-content reads. The bridge also allowlists upstream tools and blocks pre-signed URL creation. It does not grant AWS writes or arbitrary scripts with write-capable credentials. AWS writes, when approved for a specific deployment, belong to a separate reviewed GitHub OIDC workflow identity. The current gateway build and recovery roles trust only their respective repositories' `main` branches and restrict actions and resources; this is not a claim that a GitHub protected-environment approval gate is configured. Do not add broad write permissions to the gateway task role or reader role.

## Rollout and acceptance

The source and mocked tests must be reviewed and merged before building a unique, immutable gateway image. Verify the image digest and source commit, then perform the approved dry-run infrastructure/configuration review before any apply. Record the prior task definition and operator configuration so rollback can restore the previous task revision and lane bindings. Deployment approval, apply, production health checks, and rollback decisions belong to the service owner.

Before enabling a lane, verify all of the following:

- The intended connector or client is bound to the correct company lane, and the lane can discover the AWS tools.
- The gateway's lane authorization permits only the approved lanes; an unapproved lane and unsupported authentication grants fail before STS is called.
- STS `AssumeRole` uses only the configured pinned read-only role, and its returned ARN is validated before AWS MCP is contacted.
- Credential renewal succeeds repeatedly across simulated one-hour sessions for more than 18 hours, including concurrent calls, base task-role credential rotation, a transient STS failure, expiry fail-closed behavior, and recovery.
- CloudTrail records the expected gateway session name, and logs do not contain credentials, session tokens, signatures, or script contents.
- The AWS MCP call remains read-only, outputs remain bounded and redacted, the kill switch stops calls before STS, and the deployed service passes its normal health checks.

These checks establish the design and deployment state at the time they run. A claim of continuous production availability beyond 12 hours requires a separate observation covering that elapsed time, including successful renewals and service health; it must not be inferred from simulated-clock tests.

## Source references

- `src/tools/aws-mcp/credentials.ts` implements the assumed-role credential cache and refresh path.
- `src/tools/aws-mcp/signed-fetch.ts` signs AWS MCP transport requests with SigV4.
- `src/tools/aws-mcp/access.ts`, `src/catalog/governance.ts`, and `src/tools/registry.ts` enforce lane access and tool visibility.
- `src/config/env.ts` and `src/server/oauth.ts` define gateway OAuth access-token and refresh-token lifetimes.
- `infra/aws/iam.tf` defines the ECS task role; the reader role is an owner-managed IAM role and is not managed by this Terraform file.

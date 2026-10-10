# Gateway ECR build authentication

`.github/workflows/build-gateway-ecr.yml` authenticates to AWS with the fixed role
`arn:aws:iam::900915535335:role/otchealth-github-ecr-push-gateway`. It does not depend on a
repository variable or static AWS keys. The workflow clears inherited AWS credentials before
requesting the role through GitHub OIDC, so a missing or rejected OIDC configuration fails the
build instead of selecting another credential path.

The role's checked-in trust policy in `otchealth-cto/infra/oidc/policies/trust-gateway-ecr-push.json`
trusts only `InnerScopeHearing/otchealth-mcp-server` on `main`. Its companion permissions policy
limits ECR access to the `otchealth-mcp-gateway` repository (plus the registry-wide authorization
token action). The workflow only builds and pushes the image; it does not deploy it.

Authentication changes do not alter image identity: the default tag remains the checked-out short
commit SHA, an explicitly requested tag is still honored, and the build embeds `GITHUB_SHA` while
recording and verifying the resulting ECR index and platform digests.

For the authenticated deep-health workflow, `expected_image_digest` is the exact serving runtime
`ImageID` reported in the revision receipt. Before dispatch, compare that observed value with the
retained pinned release index and record the child digest for the serving task's architecture. Pass
the observed `ImageID` unchanged: the checker requires exact equality and does not normalize between
an index and a child digest or accept another platform's child as a fallback.

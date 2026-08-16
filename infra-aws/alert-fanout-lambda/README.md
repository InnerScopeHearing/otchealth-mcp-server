# otchealth-aws-alert-fanout

Replaces the dead SNS -> email alert path with one that needs no human click.

## The problem this fixes

SNS topic `otchealth-aws-alerts` (us-east-1, account `900915535335`) had exactly one
subscription: `protocol=email` to `matthew@otchealth.app`, status `PendingConfirmation`
since creation. Email/email-json subscriptions require the recipient to click a
confirmation link before SNS will deliver anything to them; the confirmation email was
never received, and SNS confirmation tokens expire after 3 days, so that subscription
is permanently dead. Five CloudWatch alarms (`otchealth-alb-5xx`,
`otchealth-alb-unhealthy-targets`, `otchealth-gateway-no-tasks`, `otchealth-opensearch-red`,
`otchealth-rds-low-storage` -- both their `AlarmActions` and `OKActions`) route to this
topic, so nothing had ever actually been delivered for any of them.

Correction to an earlier assumption: the account's 4 AWS Budgets do **not** route
through this SNS topic at all -- they use AWS Budgets' own native `EMAIL` subscriber
type, a separate mechanism that does not require confirmation and was unaffected by
this issue.

## The fix

Lambda, SQS, and HTTPS(-with-echo) subscriptions auto-confirm; only email/email-json
subscriptions need a human click. `deploy.mjs` subscribes a Lambda (`protocol=lambda`)
to the topic, which confirms itself instantly on `Subscribe`. The dead email
subscription is left in place (harmless -- it just never receives anything).

Every message published to the topic (any CloudWatch `AlarmActions`/`OKActions`
firing, or anything else published there in future) is fanned out, independently and
concurrently, to four channels the fleet can read back and prove received:

1. **GitHub issue comment** -- `InnerScopeHearing/otchealth-mcp-server` issue
   [#226](https://github.com/InnerScopeHearing/otchealth-mcp-server/issues/226)
   ("AWS Fleet Alerts (SNS -> Lambda fanout)"). **Not** issue #21 ("Nightly Medic
   Log"): #21 hit GitHub's hard 2500-comment cap around 2026-08-10
   (`403 Commenting is disabled on issues with more than 2500 comments`) and has
   404/403'd on every new comment since -- a separate, real silent-failure worth
   fixing (rotate its poster to a fresh issue, or auto-roll on 403) but out of scope
   here.
2. **Datadog Event** (Events API v1, `POST /api/v1/events`).
3. **PostHog capture** (`aws_fleet_alert` event, Gateway Ops project).
4. **Microsoft Graph email**, best-effort -- same app-only client-credentials
   mechanism as the gateway's own `graph_send_email` tool
   (`src/graph/api-client.ts`), sent as `coo@otchealthmart.com` (on that app's
   Exchange `ApplicationAccessPolicy` allowlist) to `matthew@otchealth.app` (the
   original dead subscription's target). Listed last because it is the hardest of
   the four to prove delivered without human inbox access, so it must never be the
   only channel.

One channel failing (rate limit, transient 5xx, expired secret) never blocks the
others -- each is wrapped in its own try/catch (`Promise.allSettled`) and logged
independently to CloudWatch Logs. The invocation only throws (triggering SNS's
built-in Lambda retry) if every channel failed for every record in the batch.

## Least privilege

Execution role `otchealth-aws-alert-fanout-role`:

- `AWSLambdaBasicExecutionRole` (AWS managed policy) -- CloudWatch Logs only
  (`CreateLogGroup`/`CreateLogStream`/`PutLogEvents`).
- Inline policy `alert-fanout-secrets-read`:
  - `ssm:GetParameter` + `ssm:GetParameters` scoped to exactly the 10 parameter
    ARNs `index.mjs` reads (not a `/otchealth/*` wildcard -- deliberately narrower
    than the existing `otchealthTaskRole` gateway-task-role pattern this was
    modeled on, since this function has no need to touch the other ~434
    parameters in that namespace).
  - `kms:Decrypt` on `Resource: "*"` scoped by `Condition: {StringEquals:
    {"kms:ViaService": "ssm.us-east-1.amazonaws.com"}}` -- the same pattern
    `otchealthTaskRole` uses; the condition means this grant is usable only when
    SSM itself is the caller, never for decrypting anything else directly.

No `sns:*` permission is needed on the execution role -- SNS invokes the function
via the Lambda resource policy (`AddPermission`, principal `sns.amazonaws.com`,
scoped `SourceArn` = the topic ARN), which is a separate mechanism from the
execution role.

## Files

- `index.mjs` -- the handler. Single file, zero npm dependencies (mirrors the
  fleet's `/tmp/awsx/sig.mjs` convention: a hand-rolled SigV4 signer using the
  Lambda's own execution-role credentials, injected automatically by the runtime).
- `deploy.mjs` -- idempotent provisioner. Creates/updates the IAM role, zips
  `index.mjs`, creates/updates the function, grants the SNS invoke permission,
  and subscribes it to the topic. Safe to re-run after any `index.mjs` edit:
  `AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... node deploy.mjs`.

## Deployed state (last verified 2026-08-16)

```
role:         arn:aws:iam::900915535335:role/otchealth-aws-alert-fanout-role
function:     arn:aws:lambda:us-east-1:900915535335:function:otchealth-aws-alert-fanout
              (nodejs22.x, 128MB, 30s timeout)
subscription: arn:aws:sns:us-east-1:900915535335:otchealth-aws-alerts:09667df5-39cf-4e61-9714-cb82f089aadb
              (CONFIRMED)
```

End-to-end verified live: two real `sns:Publish` calls to the topic (one shaped like
a real CloudWatch alarm state-change payload, one plain text) both landed in all
four channels within ~2 seconds, independently confirmed by querying each channel's
own API back afterward (not just trusting the Lambda's self-reported success).

## Cost

Priced from the AWS Price List API (`ServiceCode=AWSLambda`,
`location=US East (N. Virginia)`): Requests `$0.0000002` each (Tier 1, 0 to 6B),
Duration `$0.0000166667` per GB-second (Tier 1, 0 to 6B GB-second-units). At 128MB
and an observed ~4.3s worst-case duration per invocation (~0.56 GB-seconds), and
any realistic volume of infrastructure guardrail-alarm firings (even several
hundred a month), this sits entirely inside AWS Lambda's perpetual free tier
(1,000,000 requests + 400,000 GB-seconds every month, not a 12-month trial) --
**effectively $0.00/month**. A generous non-free-tier estimate at 1,000
invocations/month is about $0.01/month. Negligible against the $625/mo ceiling
either way.

# Cloud browser rollout and acceptance

The gateway provides authenticated MCP actions backed by AWS browser sessions. It does not start a second language model. DynamoDB stores owner-bound session/job state, SQS dispatches deterministic jobs, and S3 retains versioned result artifacts. The existing ECS gateway polls the queue, so the operator's laptop is not required for job execution.

## Deployment inputs

- `CLOUD_BROWSER_ENABLED=true`
- `CLOUD_BROWSER_WORKER_ENABLED=true`
- `CLOUD_BROWSER_DDB_TABLE=otchealth-browser-cloud`
- `CLOUD_BROWSER_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/900915535335/otchealth-browser-cloud`
- `CLOUD_BROWSER_ARTIFACT_BUCKET=otchealth-chat-agents-900915535335-us-east-1`
- `AWS_REGION=us-east-1`

The table has a string partition key `pk` with no sort key, on-demand capacity, encryption, and TTL on `expiresAtEpoch`. The standard queue uses managed encryption and 120-second visibility. Application leases and idempotency handle duplicate delivery. The existing artifact bucket must have versioning enabled. Runtime permissions are recorded in `infra/aws/browser-cloud-runtime-policy.json`; DynamoDB transaction authorization uses the component item permissions, not an invented TransactWriteItems IAM action.

No credentials are included in these files. ECS obtains temporary AWS credentials from its task role. Saved website cookies remain in AgentCore browser profiles. Browser observations and artifacts can contain sensitive page data and require the same agent ownership checks as the source session.

## Candidate acceptance before gateway activation

Build the candidate image from the exact reviewed commit. Run `node dist/server/cloud-browser-acceptance.js` in a one-off ECS task with the gateway task role and the configuration above, before changing the live service. It verifies public navigation, page content, cross-owner denial, profile save, durable queue execution, idempotency, and a versioned artifact. The test logs boolean receipts and opaque job IDs, not page contents or credentials.

The pre-provisioned acceptance profile is `cto-public-trial`, owned by `cto`, with example.com, www.example.com and docs.aws.amazon.com as allowed hosts. It is not a website login or enrollment for another agent.

After acceptance, release through the standard build workflow and ECS revision update, retain the prior image/revision, wait for stable tasks, verify health and catalog from both replicas, and repeat the public test through the live MCP client.

## Per-agent readiness

Each agent requires its own owned profile and a test from its actual Chat or other supported MCP connection. Seeing tools in a catalog is not evidence of browser access. A passing root or task-role test is not evidence of Chat client acceptance. Human sign-in and any website challenges must use the provider's supported interactive session.

Acceptance requires: discover tools, start owned session, navigate, read, perform an authorized reversible edit, verify saved state, retrieve a job artifact, reconnect and retrieve the result again, and confirm another seat cannot use the session or artifact. Do not mark a seat ready until these receipts exist.

## Limits and remaining scope

This initial provider supports bounded navigate/click/type/wait/observation operations. It is not yet full desktop control. File upload/download, image screenshots, a user-facing sign-in/live-view flow, broader background plans, and Daytona transport require separate implementation and acceptance. The existing Daytona Linux desktop trial does not prove Chat MCP integration. No 64 GiB Windows desktop or vendor capacity request is part of this rollout.

Runtime limits are 180 seconds per session, 20 actions and 10 sessions per owner per UTC day. These are initial trial limits, not a promise of unlimited access or an account-wide dollar cap. Monitor actual gross AWS usage before increasing them. Disable the worker and browser feature flags to stop new dispatch, reconcile active sessions, and restore the prior ECS task definition if acceptance fails.

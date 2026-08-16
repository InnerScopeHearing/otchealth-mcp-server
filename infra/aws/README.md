# otchealth AWS estate -- Terraform capture (2026-08-16)

This directory is a **capture-only** Terraform representation of the live AWS production estate
behind the otchealth MCP gateway (account `900915535335`, region `us-east-1`). It exists so the
estate has a rebuild path if the account were ever lost. **It has never been applied. It has
never even been `terraform plan`-verified** -- see "What is NOT verified" below before trusting
any of it blindly.

## What this captures

Every resource verified live via direct signed AWS API calls on 2026-08-16 (not trusted from any
prior document):

| Concern | File | Resources |
|---|---|---|
| Network | `network.tf` | The account's default VPC + 4 of its 6 default subnets (data sources only -- see file header for why) |
| Security | `security-groups.tf` | 3 custom SGs (alb-public, gateway-tasks, dbtools) + the VPC's default SG (adopted, holds RDS's 5432 ingress), 10 individual ingress/egress rules |
| TLS | `acm.tf` | The `mcp.otchealth.app` ACM certificate (data source) |
| Load balancing | `alb.tf` | The ALB, its target group, both listeners (80->redirect, 443->forward) |
| Compute | `ecs-cluster.tf`, `ecs-gateway.tf`, `ecs-jobs.tf` | 1 cluster, the gateway service + its task definition, 26 more task-definition families (data-driven) -- **27 families total, matching the live count** |
| Scheduling | `scheduler.tf` | All 22 EventBridge Scheduler entries (data-driven), every one **DISABLED**, matching live state |
| Data | `rds.tf`, `opensearch.tf`, `dynamodb.tf` | `otchealth-pg` (RDS Postgres), `otchealth-brain` (OpenSearch), `otchealth-customer-360` (DynamoDB) |
| Storage | `s3.tf` | All 4 S3 buckets + their public-access-block/encryption/ownership/versioning sub-resources |
| Identity | `iam.tf` | 4 roles (task, ECS execution, CodeBuild, Scheduler) + their inline policies + the 1 attached managed policy |
| CI/CD | `ecr.tf`, `codebuild.tf` | 5 ECR repositories, 2 CodeBuild projects |
| Observability | `logs.tf` | The shared `/ecs/otchealth` log group |
| Secrets (metadata only) | `ssm.tf` | An inventory of all 444 `/otchealth/*` SSM parameter NAMES -- see "Secrets and state" |
| Adoption | `imports.tf`, `import.sh` | Every resource above mapped to a real AWS id via native `import` blocks |

## What is NOT captured, deliberately

**The `otchealth-aws-alert-fanout` Lambda + its IAM role + the `otchealth-aws-alerts` SNS topic.**
Discovered live during this capture but excluded on purpose: the role's `CreateDate` and the
function's `LastModified` are both from **minutes before** this capture ran (2026-08-16T03:18Z),
matching a still-in-progress batch of ~20 numbered debugging scripts in the shared sandbox
(`alertlambda-01-sns.mjs` through `alertlambda-21-pricing3.mjs`, spanning 03:05-03:23 the same
morning) that was still actively iterating (pricing lookups, log checks, an "independent verify"
pass) at the moment this file was written. This is evidently another session's live, in-progress
work. Capturing it now would freeze an incomplete configuration and risks colliding with that
session's edits the moment anyone tried to import it -- the exact clobbering failure mode this
task's isolation instructions exist to prevent, just extended from git to a shared AWS account.
**Recommend a dedicated follow-up capture pass once that pipeline visibly settles** (no file
timestamp changes in `/tmp/awsx/alertlambda-*` for a while, and the Lambda's `LastModified` stops
moving).

**Anything not reachable from the resources above.** This capture did not go looking for Route
53, WAF, Budgets, CloudTrail, VPC Flow Logs, Config, GuardDuty, or Organizations-level resources
-- none were in the estate list this was scoped from, and none showed up as a dependency of
anything that was (e.g. no WAF WebACL is associated with the ALB; verified by omission, not by an
explicit DescribeWebACL call). If any of those exist and matter, they need their own pass.

## Real findings beyond the original estate description (flag for the CTO)

These were discovered live and are captured, but were **not** in the estate description this
configuration was scoped from -- worth a second pair of eyes:

1. **RDS sits on a 4th subnet** (`subnet-00d12661411020144`, us-east-1c) that is outside the
   3-subnet set the ALB and ECS tasks use -- it uses the VPC's default (all-6-subnets) DB subnet
   group, not a scoped one.
2. **S3 versioning is NOT uniform**: 3 of the 4 buckets have it Enabled; `otchealth-build` does
   not (never turned on, not "Suspended"). See `s3.tf`'s header.
3. **2 CodeBuild projects and 5 ECR repositories** exist and were not mentioned at all. Only 2 of
   the 5 ECR repos are referenced by anything in this account (`otchealth-mcp-gateway`,
   `doc-indexer`); the other 3 (`otchealth-os-chat`, `fourvault-api`, `pressgolf-api`) belong to
   other apps in the portfolio per `otchealth-cto/CLAUDE.md` and are not wired to anything here --
   see `ecr.tf`'s header.
4. **A 5th custom IAM role + a Lambda + an SNS topic** -- see "What is NOT captured" above.
5. **A likely false alarm, investigated and resolved, not a finding**: an early pass at
   `DescribeSecurityGroupRules` appeared to show a wide-open `-1`/`0.0.0.0/0` **ingress** rule on
   the default SG that backs RDS. Cross-checked against the raw `DescribeSecurityGroups` XML
   (the authoritative source): no such ingress rule exists. Root cause: `fast-xml-parser`
   auto-converts `"true"`/`"false"` text nodes to real JS booleans, and the debug script compared
   `isEgress === 'true'` (a string) against that boolean, which is always `false` -- so every
   rule, including the SG's genuine EGRESS rule, printed as "INGRESS". Fixed by comparing against
   the boolean `true`; the corrected script confirms `security-groups.tf` was already right (it
   was written from the raw `DescribeSecurityGroups` response, not the buggy rule-listing
   script). Documented here because it is exactly the "silently returns partial/wrong results
   read as real" failure class this task warned about, and it is worth knowing this specific
   parser gotcha exists for any future AWS XML work in this account.

## Secrets and state (read this before adding an `aws_ssm_parameter` resource)

**No secret value appears anywhere in this directory.** The 444 `/otchealth/*` SSM parameters are
inventoried by NAME and metadata only (`data/ssm-parameter-inventory.json`), generated exclusively
via `DescribeParameters` -- an API call that cannot return a value under any circumstance.
Wherever a secret is actually consumed (ECS `secrets[].valueFrom`), it is an ARN string, never a
fetched value. `ssm.tf`'s header explains at length why SSM parameter *values* are never modeled
as Terraform resources: the `aws_ssm_parameter` resource's schema requires a `value`, and
importing one (SecureString, decrypted) writes the plaintext into **local Terraform state** --
`lifecycle.ignore_changes` does not prevent this, because the write happens on the read/import
itself. 438 of the 444 parameters are SecureString; managing them this way would mean the first
`terraform import` writes 438 real secrets into a file on disk. This directory does not do that.

**RDS's master password** (`rds.tf`) is a required Terraform argument this API can never supply
(RDS never returns it, and this instance does not use Secrets-Manager-managed rotation --
verified: no `MasterUserSecret` in `DescribeDBInstances`). The `password` field contains an
**obvious placeholder string**, not a real credential, protected by `lifecycle.ignore_changes` so
it is inert even if this were ever applied.

**Before the first real `terraform import`**: configure a remote backend (S3 + a DynamoDB lock
table, or Terraform Cloud). Local state for an estate this size -- and containing full ECS
container definitions with environment variables -- should never be the only copy, and should
never be committed to this repo.

## Judgment calls made (flagged, not silently decided)

- **`aws_ecs_service` import ID format** (`imports.tf`): assumed `cluster-name/service-name`
  (current AWS provider v5 convention). This has changed across major provider versions in the
  past. **Verify against the actual provider version in use before relying on it** -- if `plan`
  rejects the id, check the provider's CHANGELOG for `aws_ecs_service` import format changes.
- **Task-level vs container-level cpu/memory** (`ecs-jobs.tf`): the live API always echoes a
  container-level `cpu: 0` even when only the task level is actually set (confirmed on the
  gateway's own container definition). This configuration omits the container-level override
  entirely for all 27 task definitions, letting the (always-present, always-correct) task-level
  `cpu`/`memory` govern -- matching how these tasks actually run today.
- **Data-driven `for_each` for 26 job task definitions and 22 schedules**, instead of 48
  hand-written near-duplicate resource blocks. Chosen for exactness (some job container
  definitions carry many KB of inline base64-encoded script -- see `ecs-jobs.tf`'s header --
  transcribing that by hand risks a silent corruption a diff would not catch) at the cost of the
  actual container/schedule shape living in `data/*.json` rather than directly in `.tf` files.
  Read those JSON files if you need to see exactly what a given job runs.
- **`lifecycle.ignore_changes = [container_definitions]`** on every `aws_ecs_task_definition`, and
  `[task_definition]` on the service. Deploys (CodeBuild pushes a new image tag; the gateway's
  `REVISION_STAMP` env var changes every release) happen far more often than this estate's
  *structure* changes, and this configuration should not fight a live release pipeline over the
  currently-running revision. It adopts and tracks the STRUCTURE; the release process keeps
  releasing outside Terraform unless someone deliberately wires it in later.
- **Data sources, not resources, for the default VPC/subnets/DB-subnet-group/ACM-certificate.**
  None of these were created by the team (they are AWS/engine defaults, or -- for the cert -- a
  DNS-validated issuance that is not safely re-runnable). See each file's header for the specific
  reasoning; the general principle is "adopt via a construct that literally cannot destroy or
  recreate the thing," and a `data` source is the strongest version of that guarantee available.

## What is NOT verified

- **`terraform init` / `validate` / `plan` never ran.** No `terraform` binary was available in the
  sandbox this was written in, and per this task's instructions it was not installed globally.
  Every `.tf` file here was hand-written and reviewed by re-reading, not compiler-checked. Treat
  this as **unvalidated HCL** until someone with a real Terraform install runs `import.sh` (which
  itself only goes as far as `plan` -- see that file's header) against this directory.
- **No live resource was ever mutated, imported, or applied.** Every fact in this directory was
  gathered via read-only AWS API calls (`Describe*`/`List*`/`Get*` actions only; the one
  exception, `DescribeParameters` for the SSM inventory, is also read-only and additionally
  incapable of returning a value).
- **The plaintext ECS environment variables DID contain credential material, and the first scan
  missed it.** This bullet previously claimed a prefix scan (`sk-`, `AKIA`, `ghp_`, `xox*`, a JWT
  shape) found zero matches across the ~280 captured environment-variable values. That claim was
  wrong. Two values in `data/task-definitions-jobs.json` (the `otchealth-pgrestore` family's
  `URL_FLATSTICK` and `URL_FOURVAULT`) were full AWS SigV4 pre-signed S3 URLs, each carrying an
  access key id and a signature.

  The scan missed them for an instructive reason: it tested whether a **value started with** a
  known prefix, and here the key sat mid-string, as `...?X-Amz-Credential=AKIA.../20260814/...`.
  A prefix test can never see that. Both values are now redacted to
  `REDACTED_PRESIGNED_URL(s3://bucket/key)`, which preserves what the job actually fetched without
  the credential material.

  Exposure was bounded: the URLs were signed `20260814T044336Z` with `X-Amz-Expires=10800`, so they
  stopped granting access three hours later, and a SigV4 signature is an HMAC over a scoped signing
  key rather than the secret key itself, so the secret was never derivable from it. What was
  genuinely disclosed is the access key **id**, which alone cannot authenticate.

  `src/safety/committed-credential-guard.test.ts` now enforces this in CI across every tracked
  file, matching anywhere in the file rather than at a value boundary. **Do not re-derive
  safety from a prefix scan.** If a future capture pulls a live pre-signed URL into a data file,
  that guard fails the build before it can be committed.

# otchealth AWS estate -- Terraform capture (2026-08-16, `fmt`/`validate`-checked 2026-08-18)

This directory is a **capture-only** Terraform representation of the live AWS production estate
behind the otchealth MCP gateway (account `900915535335`, region `us-east-1`). It exists so the
estate has a rebuild path if the account were ever lost. **It has NEVER been applied, and no
resource in this directory has ever been imported.** As of 2026-08-18, `terraform fmt` and
`terraform validate` have been run and pass clean (see "What is NOT verified" below) -- that is a
syntax/internal-consistency guarantee only. **`terraform plan` has never run against real AWS
credentials, so nothing here is confirmed to actually adopt the live resources it claims to
describe.** Read the next section before running anything beyond `fmt`/`validate` yourself.

## READ THIS FIRST -- the single most dangerous property of the current state

**Applying this configuration blind, without first running a real, credentialed `terraform plan`
and reading every line of its output, risks tearing down and recreating the running production
gateway and its dependencies, or silently disabling currently-active scheduled jobs.** Two
concrete, current reasons why, not a hypothetical:

1. **Every resource declared in this configuration has a matching `import` block** (verified this
   pass -- see "Resource/import coverage audit" below: all 56 singular resources plus the 3
   `for_each` families covering 26 job task definitions, 5 ECR repositories, and 22 EventBridge
   schedules each resolve to an `import { to = ... }` address). That is the good news: nothing
   *known to this configuration* is missing an adoption path, so a correct, fully-verified `plan`
   should not try to create-fresh anything this directory already models. Import blocks are inert
   until `apply` runs (see `imports.tf`'s header), so this alone proves nothing was ever created --
   only that the intent is structurally sound.

2. **But this capture is already stale relative to live reality, and the drift is NOT all covered
   by a safety net.** Live facts verified this session, postdating the 2026-08-16 capture:
   - **EventBridge Scheduler: captured 22 schedules, ALL `DISABLED`. Live today: 27 of 32
     schedules `ENABLED`.** That is at minimum 10 schedules that exist in the account with **no
     resource or import block anywhere in this directory** (fully invisible to `plan`/`apply`,
     which is not itself destructive but means this directory is NOT a complete estate
     description), and up to 22 schedules whose captured `state = "DISABLED"` (`scheduler.tf`,
     driven verbatim by `data/schedules.json`) may now be flatly wrong for a schedule that is
     live-`ENABLED` today. **`aws_scheduler_schedule.jobs`'s `state` argument has no
     `lifecycle.ignore_changes` guard.** A `terraform apply` run today, even with perfect import
     mapping, would `plan` to flip any of those now-enabled schedules back to `DISABLED` --
     silently turning off whatever production cron jobs (the librarians, backups, health checks,
     etc. -- see `ecs-jobs.tf`) currently rely on them. **Do not `apply` this configuration until
     `data/schedules.json` is regenerated from a fresh, live `ListSchedules`/`GetSchedule` pass and
     the new schedules get their own `resource`/`import` blocks.**
   - **The gateway task definition is pinned to a stale revision.** `data/task-definition-arns.json`
     captured `otchealth-gateway:5`; live today is `otchealth-gateway:17` (task definition
     revisions are immutable in ECS -- these are two different, coexisting resources, not one
     resource that changed). This one IS covered by a safety net --
     `aws_ecs_task_definition.gateway` and `aws_ecs_service.gateway` both carry
     `lifecycle.ignore_changes` (`[container_definitions]` and `[task_definition]` respectively,
     see "Judgment calls made" below) specifically so `apply` never fights the live release
     pipeline over which revision is actually running. But the *env selectors currently live on
     revision 17* (`SEARCH_BACKEND=opensearch`, `BLOB_BACKEND=s3`, `STATE_BACKEND=postgres`,
     `LLM_PROVIDER=openai`, `EMBEDDINGS_PROVIDER=openai`, `WEB_SEARCH_PROVIDER=tavily`) are **not
     present** in `data/task-definition-gateway-container.json` (captured from revision 5, before
     those selectors existed) -- so this file is documentation of a past configuration, not the
     one currently running, and must not be read as a description of today's environment.

   **Net effect: this configuration is internally consistent (every declared resource is either a
   data source or has an import mapping) but externally stale.** A real `terraform plan` run today
   would very likely show more than an empty diff, and at least one of those diffs (the schedule
   `state` flips) is a genuine functional change to a running production system, not a cosmetic
   one. Treat any `plan` output that is NOT empty or trivially cosmetic as a stop sign, not
   something to `apply` through -- and re-capture `data/schedules.json` (and ideally re-run the
   full capture pass) before trusting this directory again.

## How an operator would actually run a safe, read-only `plan` (this sandbox cannot)

`terraform plan` cannot mutate anything by itself -- that is true of any Terraform configuration,
this one included. The risk this README warns about is entirely in what a human does *after*
reading (or not reading) the plan output. There is no dedicated Terraform-plan identity wired up
in this repo's GitHub Actions yet, so this section specifies what to provision and run, not a
button that already exists.

**What NOT to reuse:** `.github/workflows/build-gateway-ecr.yml` already authenticates to this
same AWS account (`900915535335`) via a static-key IAM user (`otchealth-ci-ecr-gateway`, secrets
`ECR_AWS_ACCESS_KEY_ID`/`ECR_AWS_SECRET_ACCESS_KEY`). That identity is deliberately scoped to
`ecr:GetAuthorizationToken` plus push/pull on one repository, and is confirmed-denied
`ssm:GetParameter` (see that workflow's own header comment). It cannot run this plan (it lacks
`ecs:Describe*`, `elasticloadbalancing:Describe*`, `rds:Describe*`, `es:Describe*`,
`dynamodb:Describe*`, `iam:Get*`/`List*`, `scheduler:Get*`, and more) and **must not be widened**
to cover this use case -- widening a narrowly-scoped CI push credential defeats the reason it was
scoped narrowly in the first place. This is a separate, new, read-only identity.

**Provision, once, with real credentials (not part of this task):** a dedicated IAM role trusted
for GitHub OIDC (`token.actions.githubusercontent.com`), condition-scoped to this exact repository
(and ideally a specific branch or a protected `environment:`, mirroring how `deploy.yml` already
scopes its Azure OIDC subject), granted a **read-only** policy covering the services this estate
touches (EC2 describe-only for the VPC/subnet/SG data sources, ECS, ELBv2, ACM, RDS, OpenSearch,
DynamoDB, S3, IAM read, ECR, CodeBuild, Logs, Scheduler, SSM `Describe*`/`GetParameters` metadata
calls only -- AWS's managed `ReadOnlyAccess` policy is a reasonable starting point, a hand-scoped
policy limited to exactly these services is tighter and preferable). No write/create/delete
permission on anything, ever, for this role -- the identity itself should make `apply` fail with
an authorization error even if someone mistakenly ran it, as a second independent safety layer
beyond "nobody types `apply`."

**Then the read-only check itself**, e.g. as a new `workflow_dispatch`-only GitHub Actions job
(mirroring `build-gateway-ecr.yml`'s dispatch-only, least-privilege pattern):

```yaml
permissions:
  id-token: write   # OIDC
  contents: read
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::900915535335:role/<the-new-read-only-role>
          aws-region: us-east-1
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.9.8   # or newer -- see bootstrap/README.md on the 1.10 native-locking tradeoff
      - working-directory: infra/aws
        run: |
          terraform init            # -backend=false until bootstrap/ is actually applied; see backend.tf.example
          terraform validate
          terraform plan -out=tfplan -input=false
          terraform show -no-color tfplan   # human-readable, goes into the job log for review
      # Deliberately NO apply step. Ever. In this workflow.
```

**Reading the output -- safe versus dangerous, given what this README already knows:**

- **Safe:** `No changes. Your infrastructure matches the configuration.` This is the only output
  that means "go ahead and treat this directory as accurate." Anything else means stop and read
  every line before doing anything further.
- **Safe-if-understood:** a plan limited to attributes this README already documents as
  cosmetic/expected (e.g. a `default_tags`-driven tag added since capture) -- cross-check every
  such diff against this README first; "I recognize this diff" is not the same as "this diff is
  safe," and a diff that merely LOOKS small (one line) can still represent a large change (see the
  schedule `state` case below, one word, `"DISABLED"` -> `"ENABLED"`, disables a live production
  cron job).
- **Expected, and exactly what this README predicts (a red flag, not a surprise):** `~ update
  in-place` on one or more `aws_scheduler_schedule.jobs[...]` resources changing `state`. Given the
  live 27-of-32-`ENABLED` fact in "READ THIS FIRST," this is very likely to appear, and applying it
  would be a real functional regression, not a no-op reconciliation. **Do not apply this diff.**
  Re-capture `data/schedules.json` first.
- **Dangerous, stop immediately:** any `-/+ destroy and re-create` (a forced replacement) on
  `aws_ecs_service.gateway`, `aws_ecs_cluster.otchealth`, `aws_lb.gateway`,
  `aws_db_instance.otchealth_pg`, `aws_elasticsearch_domain`/`aws_opensearch_domain.brain`, or any
  S3 bucket -- these are exactly the "tear down and recreate the running production gateway and its
  dependencies" outcome this README opens with. Given the resource/import audit above, a
  forced-replacement here would most likely mean an import `id` silently resolved to the WRONG
  live object (extremely unlikely given the ids were captured directly from the resources'
  own API responses, but not provably impossible without a real `plan`) rather than a missing
  import -- either way, it is a stop-and-investigate signal, never a plan to `apply` through.
- **Also dangerous, and easy to miss:** a plan that ERRORS on an import block (e.g. "Cannot import
  non-existent remote object") rather than showing a diff. This is actually the SAFE failure mode
  for a stale/wrong id (it fails loudly, refuses to proceed, and mutates nothing) -- but it is easy
  to mistake for "something is broken, let me remove the import block and let Terraform create a
  fresh one instead," which is precisely how a `create`-instead-of-`import` disaster starts. If an
  import errors, fix the id in `imports.tf` (re-verify it against a live `Describe*` call) --
  never delete the import block to make the error go away.

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
| Scheduling | `scheduler.tf` | All 22 EventBridge Scheduler entries known at capture time (data-driven), every one **DISABLED** as of 2026-08-16 -- **STALE as of 2026-08-18: live is 27-of-32 `ENABLED`, see "READ THIS FIRST" above** |
| Data | `rds.tf`, `opensearch.tf`, `dynamodb.tf` | `otchealth-pg` (RDS Postgres), `otchealth-brain` (OpenSearch), `otchealth-customer-360` (DynamoDB) |
| Storage | `s3.tf` | All 4 S3 buckets + their public-access-block/encryption/ownership/versioning sub-resources |
| Identity | `iam.tf` | 4 roles (task, ECS execution, CodeBuild, Scheduler) + their inline policies + the 1 attached managed policy |
| CI/CD | `ecr.tf`, `codebuild.tf` | 5 ECR repositories, 2 CodeBuild projects |
| Observability | `logs.tf` | The shared `/ecs/otchealth` log group |
| Secrets (metadata only) | `ssm.tf` | An inventory of all 444 `/otchealth/*` SSM parameter NAMES -- see "Secrets and state" |
| Adoption | `imports.tf`, `import.sh` | Every resource above mapped to a real AWS id via native `import` blocks |

## Resource/import coverage audit (2026-08-18)

Mechanically verified this pass, not asserted: every `resource "aws_..." "..."` block across every
`.tf` file in this directory (excluding `bootstrap/`, a separate root module, see below) has a
matching `import { to = ... }` address in `imports.tf`.

```
grep -hoE '^resource "[a-zA-Z0-9_]+" "[a-zA-Z0-9_]+"' *.tf \
  | sed -E 's/^resource "([a-zA-Z0-9_]+)" "([a-zA-Z0-9_]+)"/\1.\2/' | sort -u   # -> 56 addresses
grep -E '^\s*to\s*=' imports.tf | sed -E 's/^\s*to\s*=\s*//; s/\[.*//' | sort -u  # -> the same 56
diff <(...) <(...)   # empty
```

The 3 `for_each`-driven resources (`aws_ecr_repository.repos`, `aws_ecs_task_definition.jobs`,
`aws_scheduler_schedule.jobs`) were checked separately: each has an `import` block with a matching
`for_each` over the *identical* local (`local.ecr_repositories`, `local.job_task_defs`,
`local.schedules` respectively -- confirmed by grepping both the resource's and the import's
`for_each` line and the single point where each local is defined; Terraform does not allow two
definitions of the same local name in one module, so "identical local name" here does mean
"identical value"). Counts cross-checked against the underlying data files: 26 entries in
`data/task-definitions-jobs.json`, 22 in `data/schedules.json`, 5 in `ecr.tf`'s
`local.ecr_repositories` literal -- all matching the README table above and `imports.tf`'s own
comments.

**What this proves:** nothing this configuration currently models is missing an adoption path --
a correct `terraform plan` should not try to create-fresh any resource this directory already
declares. **What this does NOT prove:** that the import `id` values still resolve to real,
matching live resources (untested -- no credentials), or that the live account doesn't have
resources with *no* declaration here at all (it does -- see "READ THIS FIRST" above, at least 10
EventBridge schedules exist live with zero resource/import block in this directory).

## State backend: bootstrap written, NOT created

`bootstrap/` is a **separate Terraform root module** (own `provider`/`versions` block, own would-be
state) that defines what a clean remote backend for `infra/aws/` itself would need: an S3 bucket
(versioned, SSE-S3 encrypted, fully public-access-blocked, `BucketOwnerEnforced`) for state plus a
DynamoDB table (`PAY_PER_REQUEST`) for locking. **Nothing in `bootstrap/` has been created either**
-- same rule as everywhere else in this task, `fmt`/`validate` only, never `plan`/`apply`. See
`bootstrap/README.md` for the full rationale (including why DynamoDB was chosen over Terraform
1.10+'s native S3 locking given the 1.9.8 binary this was validated against, and why a legitimate
alternative exists if the team is on newer Terraform by the time this is ever applied) and the
exact one-time, by-hand sequence to actually create it. `backend.tf.example` in this directory
shows the `backend "s3" {}` block to add here, filled in from `bootstrap`'s outputs, once that
bootstrap module has actually been applied -- do not rename it to `backend.tf` before then.

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

- **UPDATE 2026-08-18: `terraform fmt` and `terraform validate` HAVE now run, both clean.** A
  `terraform 1.9.8` binary was downloaded fresh (release archive from
  `releases.hashicorp.com`, no AWS credentials involved) into a disposable sandbox, satisfying
  this configuration's own `required_version = ">= 1.7.0"` floor. `terraform fmt -recursive` found
  real misalignment (inconsistent `=` column alignment) in 7 files -- `codebuild.tf`,
  `ecs-gateway.tf`, `ecs-jobs.tf`, `opensearch.tf`, `rds.tf`, `scheduler.tf`,
  `security-groups.tf` -- fixed automatically (purely cosmetic, `fmt` never changes semantics) and
  now verified idempotent (`fmt -check` exits 0). `terraform init -backend=false` (no state,
  nothing to configure) then `terraform validate` reported **0 errors, 0 warnings** on the first
  run after the `fmt` fix -- the configuration is syntactically valid, internally consistent HCL
  (every reference resolves, every required argument is present, every type checks). The same
  sequence was run against `bootstrap/`, also clean. **This is still not what `import.sh` or
  `plan` verify** -- `validate` never contacts AWS, never resolves an `import` block's `id`
  against anything real, and cannot catch the live drift documented in "READ THIS FIRST" above (a
  syntactically perfect configuration can still be describing a world that no longer exists).
  `terraform init` / `plan` / `apply` against real AWS credentials still have never run, by design
  -- this task's instructions were to stop before that point, and doing so requires credentials
  this sandbox does not have (see `import.sh`'s header for the exact read-only-safe command an
  operator with real credentials should run, and "READ THIS FIRST" for what a safe-looking versus
  dangerous-looking `plan` output means given the known drift).
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

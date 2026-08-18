# State backend bootstrap -- NOT YET CREATED, NOT YET APPLIED

This directory is a **separate root module** from `infra/aws/`. It exists to answer "what would a
clean remote state backend for `infra/aws/` require" and to have the exact Terraform written down
for it -- it does **not** run `terraform apply` itself, and nothing in `infra/aws/` points at it
yet. It was written under the same constraint as the rest of this capture: no AWS credentials were
available in the sandbox that wrote it, so this has only been `fmt`-checked and `validate`-checked,
never planned or applied.

## Why this exists as its own directory, not resources inside `infra/aws/`

A Terraform state backend cannot durably store its own state (chicken-and-egg: the bucket that
would hold `infra/aws/`'s state can't be created *by* a `terraform apply` whose own state has
nowhere safe to live yet). The standard pattern is a tiny, rarely-touched **bootstrap** module,
applied once, by hand, with local state (acceptable here because it is two resources that almost
never change), that creates the bucket + lock table. Everything else (`infra/aws/`) then points
at that bucket via a `backend "s3" {}` block. This directory is that bootstrap module.

## What it creates (when someone with real credentials eventually runs it)

| Resource | Purpose |
|---|---|
| `aws_s3_bucket.terraform_state` | Holds every root module's remote state, one key prefix per module |
| `aws_s3_bucket_versioning` | ENABLED -- a corrupted or bad state write is recoverable via a prior object version |
| `aws_s3_bucket_server_side_encryption_configuration` | SSE-S3 (AES256) at rest, matching how every other bucket in this estate is encrypted (see `../s3.tf`) |
| `aws_s3_bucket_public_access_block` | All 4 sub-settings `true`, matching every other bucket in this estate |
| `aws_s3_bucket_ownership_controls` | `BucketOwnerEnforced` (ACLs disabled), matching every other bucket in this estate |
| `aws_dynamodb_table.terraform_locks` | State locking so two concurrent `terraform apply` runs cannot race and corrupt state; `PAY_PER_REQUEST` billing (this table takes a handful of tiny read/writes per plan/apply, provisioned capacity would be pure waste) |

## Locking: DynamoDB table chosen over S3 native locking, and why that choice is not final

Terraform 1.10+ can lock state directly in the S3 bucket itself (`use_lockfile = true` in the
`backend "s3"` block), which would let this bootstrap skip the DynamoDB table entirely. This
repository's `infra/aws/versions.tf` pins `required_version = ">= 1.7.0"` -- a floor, not a
target -- and the terraform binary this was validated against (see `../README.md`, `fmt`/`init`/
`validate` all ran successfully with **Terraform v1.9.8**, downloaded fresh for this pass) predates
1.10. A DynamoDB lock table works on every Terraform version back to 0.9 and forward through the
current release, so it is the choice that does not force a coordinated version bump on whoever
runs `terraform apply` here first. **If the team standardizes on Terraform >= 1.10 before this is
ever applied, native S3 locking is a legitimate simplification** -- drop `aws_dynamodb_table.
terraform_locks` from this file, delete the corresponding `backend` argument in
`../backend.tf.example`, and add `use_lockfile = true` there instead. That is a deliberate,
documented alternative, not an oversight.

## What this directory does NOT do

- It does **not** run `terraform init`, `plan`, or `apply` against real AWS. Nothing here has
  created an S3 bucket or a DynamoDB table. `terraform fmt` and `terraform validate` are the only
  commands that have ever run against these files (both clean, zero errors/warnings, same as
  `infra/aws/` itself -- see that directory's `README.md`).
- It has no backend block of its own (local state for a two-resource, apply-once module is the
  accepted exception to "never use local state" -- there is no meaningful loss surface here, and
  bootstrapping the bootstrap would be turtles all the way down).
- It does not touch, import, or reference anything in `infra/aws/` -- one-directional only, the
  parent module will point at this module's *output values* once both have been applied for real.

## The actual sequence, when someone with real AWS credentials for account 900915535335 is ready

```bash
# 1. Apply the bootstrap ONCE, by hand, with local state (this is the one place in this whole
#    capture where local state is fine -- see "Why local state is acceptable here" above).
cd infra/aws/bootstrap
terraform init
terraform plan   # confirm: 2 buckets... no, 1 bucket + its 4 sub-resources + 1 DynamoDB table.
terraform apply  # creates the backend infrastructure. Note the two output values.

# 2. Wire infra/aws/ to use that backend. Copy ../backend.tf.example to ../backend.tf, filling in
#    the bucket name and DynamoDB table name from this module's outputs (terraform_state_bucket,
#    terraform_lock_table).

# 3. Only THEN run infra/aws/import.sh (init + validate + plan, still never apply -- see that
#    file's header and ../README.md "What is NOT verified" for why import must be plan-verified,
#    resource by resource, before anyone lets this configuration anywhere near `apply`).
```

Do not skip step 1 and give `infra/aws/` a `backend "s3"` block pointing at a bucket that does not
exist yet -- `terraform init` will simply fail to configure the backend, which is a safe failure,
but it wastes a round trip. This bootstrap module is deliberately the first domino.

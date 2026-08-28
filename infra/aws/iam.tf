/**
 * IAM roles. Verified live 2026-08-16 (IAM GetRole / ListRolePolicies / GetRolePolicy /
 * ListAttachedRolePolicies). Four roles captured here; every AWS-managed or SSO-managed
 * service-linked role in the account (name prefixes "AWSServiceRoleFor", "AWSReservedSSO_",
 * "AWSControlTower") is out of scope for this configuration (not created by or for this estate,
 * and Terraform should never attempt to manage a service-linked role's trust policy).
 *
 * NOT CAPTURED, DELIBERATELY (flag for the CTO): a 5th custom role,
 * "otchealth-aws-alert-fanout-role" (trust = lambda.amazonaws.com), plus its Lambda function
 * "otchealth-aws-alert-fanout" and SNS topic "otchealth-aws-alerts", were discovered live during
 * this capture. They were EXCLUDED because they are evidently being actively built by a DIFFERENT
 * concurrent session right now: the role's CreateDate (2026-08-16T03:18:23Z) and the function's
 * LastModified (2026-08-16T03:18:40Z) are both from minutes before this capture ran, matching a
 * live, still-in-progress batch of ~20 numbered debugging scripts
 * (/tmp/awsx/alertlambda-01-sns.mjs .. alertlambda-21-pricing3.mjs, timestamped 03:05-03:23 the
 * same morning) that was still iterating (pricing lookups, log inspection, independent
 * verification passes) at the moment this file was written. Capturing a resource mid-construction
 * risks freezing an incomplete configuration into this file and, if ever imported, colliding with
 * that other session's live edits -- exactly the clobbering failure mode this whole task's
 * ISOLATION instructions exist to avoid, just extended to a shared AWS account instead of a
 * shared git checkout. Recommend a dedicated follow-up capture pass once that pipeline settles.
 */

# --- ECS task role: what the RUNNING gateway/job containers can call ---
resource "aws_iam_role" "task" {
  name = "otchealthTaskRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "task_runtime_access" {
  name = "runtime-access"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = [
          aws_s3_bucket.brain_dr.arn,
          "${aws_s3_bucket.brain_dr.arn}/*",
          aws_s3_bucket.finance_legal_dr.arn,
          "${aws_s3_bucket.finance_legal_dr.arn}/*",
        ]
      },
      # 2026-08-28: adjacent gap closed alongside the PersonalLegalRingReadWrite edit below (same
      # underlying cause -- Azure's permanent deletion made every S3-mirror write path load-bearing
      # instead of best-effort). `company` is already in S3_WRITABLE_CONTAINERS
      # (src/legal/blob-store.ts), so a company-container legal_blob_move/delete already lands its
      # copy-to-_TRASH step then 403s on the delete-original step, silently leaving a duplicate
      # rather than completing the move -- the statement above never granted s3:DeleteObject on
      # finance_legal_dr. Object-level only (`/*`); no bucket-level delete action is needed.
      {
        Effect   = "Allow"
        Action   = ["s3:DeleteObject"]
        Resource = ["${aws_s3_bucket.finance_legal_dr.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/otchealth/*"
      },
      {
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com" } }
      },
      {
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["es:ESHttpGet", "es:ESHttpPost", "es:ESHttpPut", "es:ESHttpDelete", "es:ESHttpHead"]
        Resource = "${aws_opensearch_domain.brain.arn}/*"
      },
      {
        # 2026-08-28: DOCUMENTATION-ONLY EDIT (same "never applied" caveat as the block below --
        # this Terraform has no live state, see versions.tf/imports.tf/import.sh; the real grant, if
        # this lands, is a read-modify-write `aws iam get-role-policy`/`put-role-policy` against the
        # live `otchealthTaskRole`/`runtime-access` policy, never `terraform apply`). Unlike the
        # PersonalLegalRingReadWrite statement below, this is NOT a Matt-approval-gated ring
        # decision -- it grants publish on one specific, already-Matt-approved-and-deployed
        # monitoring topic (see infra-aws/alert-fanout-lambda/README.md), the same low-risk class as
        # every other read/observability grant in this policy.
        #
        # Backs server/webhooks.ts's postAlert() SNS fallback (SNS_ALERT_TOPIC_ARN env, inert when
        # unset): when the primary GitHub-issue-comment alert route itself fails (as it silently has
        # since issue #21 hit GitHub's 2500-comment cap ~2026-08-10), the alert is ALSO published to
        # this topic, which already fans out to GitHub issue #226 + Datadog + PostHog + Graph email
        # via the deployed otchealth-aws-alert-fanout Lambda -- so a capped/renamed/deleted issue can
        # never again silently eat every fleet-medic alert. Scoped to the single topic ARN, not `*`.
        Sid      = "FleetMedicSnsAlertFallback"
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = "arn:aws:sns:${var.aws_region}:${var.aws_account_id}:otchealth-aws-alerts"
      },
      {
        # 2026-08-28: DOCUMENTATION-ONLY EDIT, PENDING EXPLICIT OWNER (Matt) APPROVAL -- this
        # Terraform has never been applied to real state (see versions.tf/imports.tf/import.sh's own
        # "never applied" headers), so this Sid rename + widened Action list records the PROPOSED
        # target state for the gateway-tail PR; it is NOT itself the mechanism that grants anything.
        # If approved, the live grant is applied out-of-band via a read-modify-write
        # `aws iam get-role-policy` / `put-role-policy` against the real `otchealthTaskRole` /
        # `runtime-access` policy (the same discipline as the CIO secret change), NEVER
        # `terraform apply` -- a first apply here would evaluate every import block estate-wide
        # against 10+ days of unrelated live drift (task-def rev 22, EVAL_AGENT_TOKEN, the
        # deliberately-uncaptured alert-fanout role/Lambda/SNS per this file's own header) and, far
        # worse, rds.tf's `password = "CHANGEME-placeholder-never-applied-real-password-unknowable-
        # via-api"` would attempt to reset the LIVE RDS master password to that literal placeholder.
        #
        # Was Sid "PersonalLegalRingReadOnly" / Action ["s3:GetObject","s3:ListBucket"]. Adds
        # PutObject + DeleteObject so `legal_blob_put`/`legal_blob_delete`/`legal_blob_move` on the
        # `personal` container (src/legal/blob-store.ts's S3_WRITABLE_CONTAINERS, that file's own
        # comment carries the full rationale + approval-gate pointer) can actually write instead of
        # falling through to permanently-dead Azure. DeleteObject is safe to grant alongside PutObject
        # because legal_blob_delete/legal_blob_move are copy-to-_TRASH/copy-then-delete flows, never a
        # direct unrecoverable removal, and the bucket is versioned (s3.tf:136-139; live-read
        # 2026-08-28 confirms Status=Enabled -- re-verify immediately before granting, not just at
        # PR-authoring time). This does NOT touch who may reach `personal` at all: that ring
        # (PERSONAL_LEGAL_RING = ['clo-personal','exec'], src/tools/kb/search-privileged.ts, enforced
        # by src/tools/legal/ring.ts before any store call) is untouched by this statement.
        Sid      = "PersonalLegalRingReadWrite"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket", "s3:PutObject", "s3:DeleteObject"]
        Resource = [aws_s3_bucket.legal_personal_dr.arn, "${aws_s3_bucket.legal_personal_dr.arn}/*"]
      },
    ]
  })
}

# --- ECS execution role: what ECS itself needs to LAUNCH a task (pull image, write logs, resolve
# the `secrets` block's SSM valueFrom entries into the container's env before it starts) ---
resource "aws_iam_role" "ecs_execution" {
  name = "otchealthEcsExecutionRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_read_job_env_files" {
  name = "read-job-env-files"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.build.arn}/jobenv/*" },
      { Effect = "Allow", Action = ["s3:GetBucketLocation"], Resource = aws_s3_bucket.build.arn },
    ]
  })
}

resource "aws_iam_role_policy" "ecs_execution_read_ssm_parameters" {
  name = "read-otchealth-parameters"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameters", "ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/otchealth/*"
      },
      {
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com" } }
      },
    ]
  })
}

# --- CodeBuild service role (see codebuild.tf) ---
resource "aws_iam_role" "codebuild" {
  name = "otchealthCodeBuildRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "codebuild_inline" {
  name = "otchealthCodeBuildInline"
  role = aws_iam_role.codebuild.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload",
          "ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
          "ecr:DescribeRepositories", "ecr:ListImages",
        ]
        Resource = "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${aws_s3_bucket.build.arn}/*"
      },
    ]
  })
}

# --- EventBridge Scheduler's role: lets it RunTask on the otchealth cluster only, and PassRole
# the two ECS roles above only when the target is ecs-tasks.amazonaws.com (see scheduler.tf) ---
resource "aws_iam_role" "scheduler" {
  name = "otchealthSchedulerRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_run_task" {
  name = "otchealthSchedulerRunTask"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = ["arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/*"]
        Condition = { ArnLike = { "ecs:cluster" = aws_ecs_cluster.otchealth.arn } }
      },
      {
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = [aws_iam_role.ecs_execution.arn, aws_iam_role.task.arn]
        Condition = { StringLike = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
    ]
  })
}

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
        Sid      = "PersonalLegalRingReadOnly"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
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

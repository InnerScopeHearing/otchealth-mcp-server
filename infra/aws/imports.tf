/**
 * IMPORT MAPPING -- every real resource id mapped to its Terraform address, using native
 * Terraform `import` blocks (stable since 1.7, this config requires >= 1.7.0 -- see versions.tf).
 *
 * WHY IMPORT BLOCKS OVER A `terraform import` CLI SCRIPT: an import block is INERT until a real
 * `terraform apply` runs -- `terraform plan` shows exactly what each one would adopt (and flags
 * any mismatch between this configuration and live reality) with ZERO state mutation. A `.sh`
 * script full of `terraform import` commands, by contrast, mutates state (and can partially
 * fail, mutate the same resource twice, or resume once) the moment it starts running. Since this
 * task is explicit that `terraform apply` must NEVER run here, import blocks are the safer of the
 * two capture mechanisms -- see import.sh for the (equally apply-free) convenience wrapper that
 * runs init/validate/plan and nothing else.
 *
 * THIS HAS NEVER BEEN RUN. No `terraform plan` has verified these ids resolve or that the
 * generated configuration matches live state byte-for-byte -- see README.md "What is NOT
 * verified" for the honest list of what capture-by-reading-and-writing cannot guarantee that an
 * actual `terraform plan` would.
 */

# ---------- Security groups + their individual rules ----------

import {
  to = aws_security_group.alb_public
  id = "sg-0aeb92d4c6cfa6eae"
}
import {
  to = aws_vpc_security_group_ingress_rule.alb_public_http
  id = "sgr-0bc7760442a7215cd"
}
import {
  to = aws_vpc_security_group_ingress_rule.alb_public_https
  id = "sgr-05c8236a65c015dcb"
}
import {
  to = aws_vpc_security_group_egress_rule.alb_public_all
  id = "sgr-015afcd104165a6e1"
}

import {
  to = aws_security_group.gateway_tasks
  id = "sg-0a5d44b67befc3bbe"
}
import {
  to = aws_vpc_security_group_ingress_rule.gateway_tasks_from_alb
  id = "sgr-04d22dc547d58dc6c"
}
import {
  to = aws_vpc_security_group_egress_rule.gateway_tasks_all
  id = "sgr-092845b3436a847f1"
}

import {
  to = aws_security_group.dbtools
  id = "sg-01dd73c929bb74632"
}
import {
  to = aws_vpc_security_group_egress_rule.dbtools_all
  id = "sgr-00c39e2b897abaf15"
}

# aws_default_security_group ADOPTS the VPC's default SG (never creates/destroys the group
# itself) -- its ingress/egress rules are inline blocks on this one resource, so no separate
# rule-id imports are needed the way the 3 custom groups above need one per rule.
import {
  to = aws_default_security_group.default
  id = "sg-038beca03a747545f"
}

# ---------- ALB ----------

import {
  to = aws_lb.gateway
  id = "arn:aws:elasticloadbalancing:us-east-1:900915535335:loadbalancer/app/otchealth-gateway/1832ed30f99bc4cc"
}
import {
  to = aws_lb_target_group.gateway
  id = "arn:aws:elasticloadbalancing:us-east-1:900915535335:targetgroup/otchealth-gateway-tg/19f35da133062984"
}
import {
  to = aws_lb_listener.http_redirect
  id = "arn:aws:elasticloadbalancing:us-east-1:900915535335:listener/app/otchealth-gateway/1832ed30f99bc4cc/1a981a7461a0f4cb"
}
import {
  to = aws_lb_listener.https
  id = "arn:aws:elasticloadbalancing:us-east-1:900915535335:listener/app/otchealth-gateway/1832ed30f99bc4cc/8e4cccf2dcaa5f73"
}

# ---------- IAM ----------

import {
  to = aws_iam_role.task
  id = "otchealthTaskRole"
}
import {
  to = aws_iam_role_policy.task_runtime_access
  id = "otchealthTaskRole:runtime-access"
}

import {
  to = aws_iam_role.ecs_execution
  id = "otchealthEcsExecutionRole"
}
import {
  to = aws_iam_role_policy_attachment.ecs_execution_managed
  id = "otchealthEcsExecutionRole/arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
import {
  to = aws_iam_role_policy.ecs_execution_read_job_env_files
  id = "otchealthEcsExecutionRole:read-job-env-files"
}
import {
  to = aws_iam_role_policy.ecs_execution_read_ssm_parameters
  id = "otchealthEcsExecutionRole:read-otchealth-parameters"
}

import {
  to = aws_iam_role.codebuild
  id = "otchealthCodeBuildRole"
}
import {
  to = aws_iam_role_policy.codebuild_inline
  id = "otchealthCodeBuildRole:otchealthCodeBuildInline"
}

import {
  to = aws_iam_role.scheduler
  id = "otchealthSchedulerRole"
}
import {
  to = aws_iam_role_policy.scheduler_run_task
  id = "otchealthSchedulerRole:otchealthSchedulerRunTask"
}

# ---------- S3 ----------

import {
  to = aws_s3_bucket.brain_dr
  id = "otchealth-brain-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_public_access_block.brain_dr
  id = "otchealth-brain-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_server_side_encryption_configuration.brain_dr
  id = "otchealth-brain-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_ownership_controls.brain_dr
  id = "otchealth-brain-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_versioning.brain_dr
  id = "otchealth-brain-dr-55c84f6b"
}

import {
  to = aws_s3_bucket.finance_legal_dr
  id = "otchealth-finance-legal-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_public_access_block.finance_legal_dr
  id = "otchealth-finance-legal-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_server_side_encryption_configuration.finance_legal_dr
  id = "otchealth-finance-legal-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_ownership_controls.finance_legal_dr
  id = "otchealth-finance-legal-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_versioning.finance_legal_dr
  id = "otchealth-finance-legal-dr-55c84f6b"
}

import {
  to = aws_s3_bucket.legal_personal_dr
  id = "otchealth-legal-personal-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_public_access_block.legal_personal_dr
  id = "otchealth-legal-personal-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_server_side_encryption_configuration.legal_personal_dr
  id = "otchealth-legal-personal-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_ownership_controls.legal_personal_dr
  id = "otchealth-legal-personal-dr-55c84f6b"
}
import {
  to = aws_s3_bucket_versioning.legal_personal_dr
  id = "otchealth-legal-personal-dr-55c84f6b"
}

import {
  to = aws_s3_bucket.build
  id = "otchealth-build-55c84f6b"
}
import {
  to = aws_s3_bucket_public_access_block.build
  id = "otchealth-build-55c84f6b"
}
import {
  to = aws_s3_bucket_server_side_encryption_configuration.build
  id = "otchealth-build-55c84f6b"
}
import {
  to = aws_s3_bucket_ownership_controls.build
  id = "otchealth-build-55c84f6b"
}
# NOTE: no versioning import for `build` -- it was never enabled (see s3.tf), so there is no
# aws_s3_bucket_versioning resource in this configuration to import onto.

# ---------- DynamoDB, OpenSearch, RDS ----------

import {
  to = aws_dynamodb_table.customer_360
  id = "otchealth-customer-360"
}

import {
  to = aws_opensearch_domain.brain
  id = "otchealth-brain"
}

import {
  to = aws_db_instance.otchealth_pg
  id = "otchealth-pg"
}

# ---------- ECR ----------

locals {
  taskdef_arns = jsondecode(file("${path.module}/data/task-definition-arns.json"))
}

import {
  # for_each requires a set or map, never a plain list (the same reason the resource block this
  # imports onto, aws_ecr_repository.repos in ecr.tf, wraps it in toset() too).
  for_each = toset(local.ecr_repositories)
  to       = aws_ecr_repository.repos[each.value]
  id       = each.value
}

# ---------- CodeBuild ----------

import {
  to = aws_codebuild_project.gateway
  id = "otchealth-gateway-build"
}
import {
  to = aws_codebuild_project.docindexer
  id = "otchealth-docindexer-build"
}

# ---------- CloudWatch Logs ----------

import {
  to = aws_cloudwatch_log_group.ecs_otchealth
  id = "/ecs/otchealth"
}

# ---------- ECS ----------

import {
  to = aws_ecs_cluster.otchealth
  id = "otchealth"
}
import {
  to = aws_ecs_cluster_capacity_providers.otchealth
  id = "otchealth"
}

import {
  to = aws_ecs_task_definition.gateway
  id = local.taskdef_arns["otchealth-gateway"].arn
}

# VERIFY BEFORE USE (flagged, not asserted as certain -- see README "What is NOT verified"): the
# AWS provider has changed aws_ecs_service's import ID format across major versions (this config
# assumes the current v5 "cluster-name/service-name" format). Confirm against the aws provider
# version this actually runs with before relying on it.
import {
  to = aws_ecs_service.gateway
  id = "otchealth/otchealth-gateway"
}

import {
  for_each = local.job_task_defs
  to       = aws_ecs_task_definition.jobs[each.key]
  id       = local.taskdef_arns[each.key].arn
}

# ---------- EventBridge Scheduler ----------

import {
  for_each = local.schedules
  to       = aws_scheduler_schedule.jobs[each.key]
  id       = "default/${each.key}"
}

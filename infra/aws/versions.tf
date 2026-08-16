terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # No backend block on purpose: this capture has never been applied, so there is no state to
  # store yet. Configure a remote backend (S3 + DynamoDB lock table, or Terraform Cloud) BEFORE
  # the first real `terraform import` -- local state for an estate this size, and containing
  # `aws_ecs_task_definition` container definitions plus (if anyone ever adds them)
  # `aws_ssm_parameter` resources, is not an acceptable place to leave it. See README.md
  # "Secrets and state" for why SSM parameter VALUES are deliberately NOT modeled as Terraform
  # resources anywhere in this directory.
}

variable "aws_region" {
  description = "AWS region the entire estate lives in. Verified live 2026-08-16: every resource below (VPC, ALB, ECS, RDS, OpenSearch, S3, DynamoDB, IAM roles are global but their resources are region-scoped, ECR, CodeBuild, CloudWatch Logs, EventBridge Scheduler) is in us-east-1. No multi-region resources were found."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = "The account this configuration is scoped to (verified via sts:GetCallerIdentity, arn:aws:iam::900915535335:user/cto-hyperagent). The provider's allowed_account_ids guard uses this so a misconfigured AWS_PROFILE/credential set fails fast instead of planning against the wrong account."
  type        = string
  default     = "900915535335"
}

variable "vpc_id" {
  description = "The default VPC this whole estate runs in (verified: vpc-0918944e0647fd0af, 172.31.0.0/16, the account's default VPC -- is_default=true). Not created by this configuration; see network.tf for why it is a data source, not a resource."
  type        = string
  default     = "vpc-0918944e0647fd0af"
}

variable "gateway_image_tag" {
  description = "The image tag currently running in the otchealth-gateway ECS service (verified live: task-definition otchealth-gateway:5 references this exact tag). CodeBuild (see codebuild.tf) pushes new tags on every build; this variable is the CURRENTLY DEPLOYED one at capture time, not a moving target this config tracks automatically -- bump it deliberately when adopting a new deploy."
  type        = string
  default     = "2da34c2"
}

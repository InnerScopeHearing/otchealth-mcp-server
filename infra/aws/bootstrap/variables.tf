variable "aws_region" {
  description = "Same region as infra/aws/ (us-east-1) -- the state bucket and lock table live in the same region as everything they will store state for."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = "Same account as infra/aws/ (900915535335). See ../variables.tf for the verification source."
  type        = string
  default     = "900915535335"
}

variable "state_bucket_name" {
  description = "S3 bucket that will hold every root module's remote Terraform state (infra/aws/ under key prefix gateway/, and any future root module under its own prefix). Account-id-suffixed to guarantee global bucket-name uniqueness without inventing an arbitrary random suffix."
  type        = string
  default     = "otchealth-terraform-state-900915535335"
}

variable "lock_table_name" {
  description = "DynamoDB table used for S3 backend state locking (see README.md for why DynamoDB over native S3 locking on the Terraform version this was validated against)."
  type        = string
  default     = "otchealth-terraform-locks"
}

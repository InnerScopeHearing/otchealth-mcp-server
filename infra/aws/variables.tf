variable "aws_region" {
  description = "AWS region the whole estate lives in. Every resource captured here is us-east-1; this is not a multi-region config."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = "The account this capture was taken from. The provider refuses to run against any other account (see providers.tf)."
  type        = string
  default     = "900915535335"
}

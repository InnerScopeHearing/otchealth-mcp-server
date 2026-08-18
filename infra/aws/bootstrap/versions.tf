terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # No backend block: this module's own state is local, deliberately -- see README.md "Why local
  # state is acceptable here". It creates exactly the two resources (plus the S3 bucket's
  # sub-resources) that everything ELSE'S remote state depends on, so it cannot depend on that
  # same remote state to bootstrap itself.
}

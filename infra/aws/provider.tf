provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      ManagedBy = "terraform"
      Project   = "otchealth-mcp-gateway"
      Captured  = "2026-08-16"
    }
  }

  # Fails fast (before any plan/apply) if these ever run against the wrong account -- an accidental
  # `terraform apply` in a DIFFERENT AWS account is a much worse outcome than a startup error here.
  allowed_account_ids = [var.aws_account_id]
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      ManagedBy = "terraform"
      Project   = "otchealth-mcp-gateway"
      Purpose   = "terraform-state-backend-bootstrap"
    }
  }

  # Same fail-fast guard as ../provider.tf: refuse to run against the wrong AWS account rather
  # than silently creating a state bucket somewhere unexpected.
  allowed_account_ids = [var.aws_account_id]
}

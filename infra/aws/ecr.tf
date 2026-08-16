/**
 * ECR repositories. Verified live 2026-08-16 (ECR DescribeRepositories) -- 5 repositories, NOT
 * mentioned in the estate description this configuration was scoped from. All 5: scanOnPush
 * enabled, image tag mutability MUTABLE, encryption AES256 (SSE-S3, not a customer KMS key).
 *
 * FLAG FOR THE CTO: only 2 of the 5 (otchealth-mcp-gateway, doc-indexer) are referenced by any
 * ECS task definition or CodeBuild project in this account (see ecs-gateway.tf, ecs-jobs.tf,
 * codebuild.tf). The other 3 -- otchealth-os-chat, fourvault-api, pressgolf-api -- correspond to
 * OTHER apps in the portfolio (per otchealth-cto/CLAUDE.md: Flatstick's backend is
 * "pressgolf-api"; FourVault's backend is "fourvault-api"; "otchealth-os-chat" matches the
 * Container App named in the same doc's Phase 5 notes). Nothing in this account's ECS cluster,
 * CodeBuild, or Scheduler touches them -- they may be pushed to from those apps' OWN CI/CD (this
 * account just hosts the registry) or be staged/leftover. This capture reports what exists and
 * takes no position on why; verify ownership/purpose before treating any of the 3 as safe to
 * prune.
 */

locals {
  ecr_repositories = [
    "otchealth-mcp-gateway",
    "doc-indexer",
    "otchealth-os-chat",
    "fourvault-api",
    "pressgolf-api",
  ]
}

resource "aws_ecr_repository" "repos" {
  for_each = toset(local.ecr_repositories)

  name                 = each.value
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

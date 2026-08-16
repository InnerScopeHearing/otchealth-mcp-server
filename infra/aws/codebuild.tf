/**
 * CodeBuild projects. Verified live 2026-08-16 (CodeBuild BatchGetProjects) -- 2 projects, NOT
 * mentioned in the estate description this configuration was scoped from, but a real and
 * directly-relevant part of the deploy pipeline: they build + push the exact two images (see
 * ecr.tf) that ecs-gateway.tf and ecs-jobs.tf reference. Both: S3 source (a zip staged into
 * otchealth-build-55c84f6b/src/, see s3.tf), privileged Docker-in-Docker build, standard:7.0
 * image, BUILD_GENERAL1_MEDIUM compute, 40-minute timeout, CloudWatch Logs enabled, SSE-S3
 * encryption (the alias/aws/s3 AWS-managed key). Each has ONE plaintext environment variable,
 * GIT_SHA, whose live VALUE is the tag most recently pushed at capture time (not a secret --
 * the image tag itself, e.g. gateway_image_tag in variables.tf) -- captured as a placeholder
 * here since a real CI run always overrides it per-build; do not treat the literal value as
 * meaningful state to preserve.
 */

resource "aws_codebuild_project" "gateway" {
  name          = "otchealth-gateway-build"
  service_role  = aws_iam_role.codebuild.arn
  build_timeout = 40

  source {
    type            = "S3"
    location        = "${aws_s3_bucket.build.bucket}/src/gateway.zip"
    buildspec       = <<-BUILDSPEC
      version: 0.2
      phases:
        pre_build:
          commands:
            - set -eu
            - test -n "$GIT_SHA"
            - aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${var.aws_account_id}.dkr.ecr.us-east-1.amazonaws.com
        build:
          commands:
            - docker build -t ${var.aws_account_id}.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway:latest -t ${var.aws_account_id}.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway:$GIT_SHA -f Dockerfile .
        post_build:
          commands:
            - docker push ${var.aws_account_id}.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway:latest
            - docker push ${var.aws_account_id}.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway:$GIT_SHA
            - echo PUSHED otchealth-mcp-gateway:$GIT_SHA
    BUILDSPEC
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_MEDIUM"
    image                         = "aws/codebuild/standard:7.0"
    type                           = "LINUX_CONTAINER"
    image_pull_credentials_type    = "CODEBUILD"
    privileged_mode                = true

    environment_variable {
      name  = "GIT_SHA"
      value = var.gateway_image_tag
      type  = "PLAINTEXT"
    }
  }

  logs_config {
    cloudwatch_logs {
      status = "ENABLED"
    }
  }
}

resource "aws_codebuild_project" "docindexer" {
  name          = "otchealth-docindexer-build"
  service_role  = aws_iam_role.codebuild.arn
  build_timeout = 40

  source {
    type            = "S3"
    location        = "${aws_s3_bucket.build.bucket}/src/tools.zip"
    buildspec       = <<-BUILDSPEC
      version: 0.2
      phases:
        pre_build:
          commands:
            - set -eu
            - test -n "$GIT_SHA"
            - aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${var.aws_account_id}.dkr.ecr.us-east-1.amazonaws.com
        build:
          commands:
            - docker build -t ${var.aws_account_id}.dkr.ecr.us-east-1.amazonaws.com/doc-indexer:latest -t ${var.aws_account_id}.dkr.ecr.us-east-1.amazonaws.com/doc-indexer:$GIT_SHA -f skills/doc-indexer/job/Dockerfile .
        post_build:
          commands:
            - docker push ${var.aws_account_id}.dkr.ecr.us-east-1.amazonaws.com/doc-indexer:latest
            - docker push ${var.aws_account_id}.dkr.ecr.us-east-1.amazonaws.com/doc-indexer:$GIT_SHA
            - echo PUSHED doc-indexer:$GIT_SHA
    BUILDSPEC
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_MEDIUM"
    image                         = "aws/codebuild/standard:7.0"
    type                           = "LINUX_CONTAINER"
    image_pull_credentials_type    = "CODEBUILD"
    privileged_mode                = true

    environment_variable {
      name  = "GIT_SHA"
      value = "4065b42"
      type  = "PLAINTEXT"
    }
  }

  logs_config {
    cloudwatch_logs {
      status = "ENABLED"
    }
  }
}

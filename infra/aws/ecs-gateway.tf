/**
 * The gateway: ECS task definition + service. THE keystone resource -- hand-written rather than
 * data-driven like ecs-jobs.tf, because it is the one piece of this estate anyone is likely to
 * actually change by hand. Verified live 2026-08-16 (ECS DescribeTaskDefinition/DescribeServices).
 *
 * The container's `environment` (82 entries, verified non-secret -- see data/README note) and
 * `secrets` (65 SSM valueFrom ARN references, NEVER values) are loaded from
 * data/task-definition-gateway-container.json rather than transcribed by hand: exact fidelity on
 * 147 array entries is far safer generated from a live API response than hand-typed, and the
 * plaintext env values (endpoint URLs, feature-flag strings, tenant/client IDs) are legitimately
 * fine to check in per this repo's OWN convention (real secrets are SSM SecureString references
 * everywhere else in this codebase too, see src/config/env.ts).
 */

locals {
  gateway_container_data = jsondecode(file("${path.module}/data/task-definition-gateway-container.json"))
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "otchealth-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "gateway"
      image     = "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/otchealth-mcp-gateway:${var.gateway_image_tag}"
      essential = true
      cpu       = 0

      portMappings = [
        { containerPort = 8080, hostPort = 8080, protocol = "tcp" }
      ]

      healthCheck = local.gateway_container_data.healthCheck

      logConfiguration = local.gateway_container_data.logConfiguration

      environment = local.gateway_container_data.environment
      secrets     = local.gateway_container_data.secrets

      mountPoints    = []
      volumesFrom    = []
      systemControls = []
    }
  ])

  lifecycle {
    # The image tag (var.gateway_image_tag) and REVISION_STAMP env var change on every real
    # deploy (CodeBuild pushes a new tag, see codebuild.tf; a redeploy bumps REVISION_STAMP) --
    # neither is something this configuration should fight a live CI pipeline over. Adopt the
    # STRUCTURE; let deploys keep deploying outside Terraform unless/until this is deliberately
    # wired into the release process.
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_service" "gateway" {
  name            = "otchealth-gateway"
  cluster         = aws_ecs_cluster.otchealth.id
  task_definition = aws_ecs_task_definition.gateway.arn

  desired_count = 2
  launch_type   = "FARGATE"

  health_check_grace_period_seconds = 120
  enable_execute_command            = false

  network_configuration {
    subnets          = local.gateway_subnet_ids
    security_groups  = [aws_security_group.gateway_tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.gateway.arn
    container_name   = "gateway"
    container_port   = 8080
  }

  deployment_controller {
    type = "ECS"
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = false
    rollback = false
  }

  lifecycle {
    # The running task definition REVISION moves on every deploy; this configuration owns the
    # SERVICE's shape (count, network, LB wiring), not which exact revision is live right now.
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener.https]
}

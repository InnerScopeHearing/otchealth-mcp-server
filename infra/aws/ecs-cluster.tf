/**
 * ECS cluster. Verified live 2026-08-16 (ECS DescribeClusters) -- ONE cluster, Container Insights
 * disabled, both FARGATE and FARGATE_SPOT capacity providers registered but NO default capacity
 * provider strategy set (every RunTask/service call specifies launchType=FARGATE explicitly, see
 * ecs-gateway.tf / scheduler.tf -- confirmed live on both the service and all 22 schedules).
 */

resource "aws_ecs_cluster" "otchealth" {
  name = "otchealth"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "otchealth" {
  cluster_name       = aws_ecs_cluster.otchealth.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  # No default_capacity_provider_strategy block: verified live that neither the service nor any
  # schedule relies on a cluster default -- each specifies launchType=FARGATE explicitly.
}

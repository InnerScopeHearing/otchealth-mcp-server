/**
 * CloudWatch Logs. Verified live 2026-08-16 (Logs DescribeLogGroups) -- ONE log group, shared by
 * every ECS task in the account (the gateway service AND all 26 job task definitions, see
 * ecs-gateway.tf / ecs-jobs.tf -- each container's logConfiguration points here with its own
 * awslogs-stream-prefix). 30-day retention, STANDARD log class, no deletion protection, no KMS
 * (default CloudWatch Logs encryption).
 */

resource "aws_cloudwatch_log_group" "ecs_otchealth" {
  name              = "/ecs/otchealth"
  retention_in_days = 30
}

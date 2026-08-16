output "gateway_url" {
  description = "The gateway's public URL."
  value       = "https://mcp.otchealth.app"
}

output "alb_dns_name" {
  value = aws_lb.gateway.dns_name
}

output "rds_endpoint" {
  value = aws_db_instance.otchealth_pg.endpoint
}

output "opensearch_endpoint" {
  value = aws_opensearch_domain.brain.endpoint
}

output "ecs_cluster_arn" {
  value = aws_ecs_cluster.otchealth.arn
}

output "job_task_definition_families" {
  description = "All 26 non-gateway task-definition families adopted by ecs-jobs.tf."
  value       = sort(keys(local.job_task_defs))
}

output "schedule_names" {
  description = "All 22 EventBridge Scheduler entries adopted by scheduler.tf (all DISABLED at capture time)."
  value       = sort(keys(local.schedules))
}

output "ssm_parameter_count" {
  description = "Count of /otchealth/* SSM parameters inventoried by NAME ONLY (see ssm.tf) -- expect 444 as of the 2026-08-16 capture."
  value       = length(local.ssm_parameter_inventory)
}

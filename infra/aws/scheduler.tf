/**
 * EventBridge Scheduler: 22 schedules, ALL DISABLED at capture time (verified live 2026-08-16,
 * every single one -- State: "DISABLED"). Each targets ecs:RunTask on the otchealth cluster with
 * a 1:1 mapping to one of the 26 job task definitions in ecs-jobs.tf (4 families -- agentstate-
 * load, agentstate-schema, pgrestore, jobenv-probe -- have NO schedule; they are one-off
 * migration/restore/diagnostic utilities run manually via RunTask, not on a cron).
 *
 * DATA-DRIVEN (data/schedules.json, generated verbatim from the live API) for the same reason as
 * ecs-jobs.tf: 22 near-identical resources are far safer generated than hand-typed, and this way
 * the cron expressions/task-definition mapping can never silently drift from what was actually
 * captured.
 *
 * group_name is always "default" (the account's default EventBridge Scheduler group -- verified
 * on all 22, not a custom group anyone created) and flexible_time_window mode is "OFF" on all 22
 * -- neither varies, so neither needs to come from the data file.
 */

locals {
  schedules = jsondecode(file("${path.module}/data/schedules.json"))
}

resource "aws_scheduler_schedule" "jobs" {
  for_each = local.schedules

  name       = each.key
  group_name = "default"

  schedule_expression          = each.value.scheduleExpression
  schedule_expression_timezone = each.value.scheduleExpressionTimezone

  # ALL 22 verified DISABLED at capture time -- this configuration adopts that state rather than
  # silently re-enabling anything. Flip individual schedules deliberately, not via a bulk default.
  state = each.value.state

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.otchealth.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.jobs[each.value.target.taskDefinitionFamily].arn
      task_count            = each.value.target.taskCount
      launch_type            = each.value.target.launchType

      network_configuration {
        subnets           = each.value.target.subnets
        security_groups    = each.value.target.securityGroups
        assign_public_ip    = each.value.target.assignPublicIp == "ENABLED"
      }
    }

    retry_policy {
      maximum_retry_attempts       = each.value.target.maxRetryAttempts
      maximum_event_age_in_seconds = each.value.target.maxEventAgeSeconds
    }
  }
}

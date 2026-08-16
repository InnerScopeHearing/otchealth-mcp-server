/**
 * The 26 non-gateway ECS task-definition families (Container Apps Jobs' AWS equivalent: nightly
 * librarians, digest, evals, xero sync, and a handful of one-off migration/restore utilities with
 * no schedule -- see scheduler.tf for which 22 of the 26 have a cron). Verified live 2026-08-16
 * (ECS DescribeTaskDefinition, all 26 families).
 *
 * DATA-DRIVEN rather than 26 hand-written near-duplicate resource blocks: data/task-definitions-
 * jobs.json is a verbatim capture (family -> cpu/memory/roles/container shape) generated directly
 * from the live API, so container definitions this large and this numerous (up to ~10KB of
 * base64-encoded inline script per job, see the file header comment there) are exactly reproduced
 * rather than re-typed and risking a transcription error. All 2 image roles (task/execution) are
 * the SAME 2 roles the gateway uses (iam.tf) -- verified identical across every one of the 27
 * families, so no per-job role variance exists to model.
 *
 * Every job's `environment` is plaintext config/inline-script-source (git URLs, cron labels,
 * base64-encoded job scripts the container decodes and runs) -- NEVER a credential; every real
 * secret is an SSM `secrets` valueFrom ARN reference, identical convention to the gateway.
 *
 * `command` and `entryPoint` are verified PRESENT (non-null) on all 26 families; `healthCheck` is
 * verified NULL on all 26 (these are one-shot RunTask jobs, not long-lived services -- only the
 * gateway's service, ecs-gateway.tf, has one). Included/omitted unconditionally on that basis
 * rather than via a per-family conditional merge: a ternary whose two branches are DIFFERENTLY-
 * shaped objects (e.g. `cond ? {command = [...]} : {}`) is a known Terraform type-unification
 * sharp edge, and every one of these values is either always-present or always-absent today, so
 * there is nothing for a conditional to actually decide. If a future 27th job genuinely needs a
 * healthCheck or lacks a command, this file needs a deliberate revisit, not a silent branch.
 */

locals {
  job_task_defs = jsondecode(file("${path.module}/data/task-definitions-jobs.json"))
}

resource "aws_ecs_task_definition" "jobs" {
  for_each = local.job_task_defs

  family                   = each.key
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                       = tostring(each.value.cpu)
  memory                     = tostring(each.value.memory)
  execution_role_arn         = aws_iam_role.ecs_execution.arn
  task_role_arn                = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = each.value.container.name
      image     = each.value.container.image
      essential = each.value.container.essential

      command    = each.value.container.command
      entryPoint = each.value.container.entryPoint

      logConfiguration = each.value.container.logConfiguration
      environment       = each.value.container.environment
      secrets            = each.value.container.secrets

      mountPoints    = []
      volumesFrom    = []
      systemControls = []
    }
  ])

  lifecycle {
    # Same reasoning as the gateway (ecs-gateway.tf): these are run via RunTask on a schedule, not
    # a long-lived service, and their inline scripts/env are expected to change per-deploy outside
    # this configuration's release cadence.
    ignore_changes = [container_definitions]
  }
}

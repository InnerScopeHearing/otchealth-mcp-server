/**
 * Security groups. Verified live 2026-08-16 (EC2 DescribeSecurityGroups). Uses the modern
 * per-rule resources (aws_vpc_security_group_ingress_rule / _egress_rule) rather than inline
 * ingress/egress blocks on aws_security_group -- the AWS-provider-recommended pattern, and it
 * lets each rule be imported/diffed independently rather than the whole group replacing on one
 * rule change.
 *
 * Three groups are genuinely team-created (alb-public, gateway-tasks, dbtools). The 4th
 * (sg-038beca03a747545f, named literally "default") is the VPC's AUTO-CREATED default security
 * group with ONE custom rule added to it (RDS's port 5432 ingress) -- modeled with
 * aws_default_security_group, the purpose-built resource for ADOPTING an account default without
 * ever creating or destroying the group itself (see network.tf's header for the same reasoning
 * applied to the VPC).
 */

# --- otchealth-alb-public: the ALB's own security group ---
resource "aws_security_group" "alb_public" {
  name        = "otchealth-alb-public"
  description = "otchealth-alb-public"
  vpc_id      = data.aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_public_http" {
  security_group_id = aws_security_group.alb_public.id
  description        = "Public HTTP (redirected to HTTPS by the listener, see alb.tf)"
  ip_protocol        = "tcp"
  from_port          = 80
  to_port             = 80
  cidr_ipv4          = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_public_https" {
  security_group_id = aws_security_group.alb_public.id
  description        = "Public HTTPS (mcp.otchealth.app)"
  ip_protocol        = "tcp"
  from_port          = 443
  to_port             = 443
  cidr_ipv4          = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_public_all" {
  security_group_id = aws_security_group.alb_public.id
  ip_protocol        = "-1"
  cidr_ipv4          = "0.0.0.0/0"
}

# --- otchealth-gateway-tasks: the Fargate tasks (ECS service + every scheduled job) ---
resource "aws_security_group" "gateway_tasks" {
  name        = "otchealth-gateway-tasks"
  description = "otchealth-gateway-tasks"
  vpc_id      = data.aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "gateway_tasks_from_alb" {
  security_group_id           = aws_security_group.gateway_tasks.id
  description                  = "Gateway container port, ALB only"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                       = 8080
  referenced_security_group_id = aws_security_group.alb_public.id
}

resource "aws_vpc_security_group_egress_rule" "gateway_tasks_all" {
  security_group_id = aws_security_group.gateway_tasks.id
  ip_protocol        = "-1"
  cidr_ipv4          = "0.0.0.0/0"
}

# --- otchealth-dbtools: operator/tooling access path to RDS (egress-only; no inbound rule found
# -- verified live, DescribeSecurityGroups returned zero ipPermissions for this group) ---
resource "aws_security_group" "dbtools" {
  name        = "otchealth-dbtools"
  description = "otchealth-dbtools"
  vpc_id      = data.aws_vpc.main.id
}

resource "aws_vpc_security_group_egress_rule" "dbtools_all" {
  security_group_id = aws_security_group.dbtools.id
  ip_protocol        = "-1"
  cidr_ipv4          = "0.0.0.0/0"
}

# --- The VPC's own default security group, adopted (not created/destroyed) -- holds RDS's 5432
# ingress from BOTH dbtools and gateway-tasks, plus the standard default-SG self-referencing
# allow-all-from-self rule and an allow-all egress. This is what RDS (rds.tf) actually sits in. ---
resource "aws_default_security_group" "default" {
  vpc_id = data.aws_vpc.main.id

  ingress {
    description = "Postgres from otchealth-dbtools and otchealth-gateway-tasks"
    protocol    = "tcp"
    from_port   = 5432
    to_port     = 5432
    security_groups = [
      aws_security_group.dbtools.id,
      aws_security_group.gateway_tasks.id,
    ]
  }

  ingress {
    description = "Default-SG self-reference (standard AWS default-SG behavior)"
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    self        = true
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

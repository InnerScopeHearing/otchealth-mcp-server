# ─────────────────────────────────────────────────────────────────────────
# NETWORK
#
# The whole estate lives in the account's stock DEFAULT VPC (172.31.0.0/16),
# unmodified: 6 subnets (one per AZ, mapPublicIpOnLaunch=true), one Internet
# Gateway, one MAIN route table (local + 0.0.0.0/0 -> igw), the default NACL.
# Verified live 2026-08-16 (DescribeVpcs / DescribeSubnets / DescribeRouteTables
# / DescribeInternetGateways, read-only). There are NO NAT gateways (a
# deliberate cost choice -- see README) and NO custom route tables.
#
# This is why the VPC/subnets/route table/IGW below are DATA SOURCES, not
# managed resources: they are AWS's own default networking, not something
# anyone provisioned deliberately, and Terraform managing a "default VPC" as a
# first-class resource is a well-known footgun (a stray `terraform destroy`
# scope, or a state/attribute mismatch, can take out the account's default
# network). Only the 4 security groups below (3 custom + the account default
# SG, which DOES carry deliberate custom rules) are managed resources.
# ─────────────────────────────────────────────────────────────────────────

data "aws_vpc" "default" {
  id = "vpc-0918944e0647fd0af"
}

# The 3 subnets actually used by the ALB / ECS tasks (one per AZ, for HA).
data "aws_subnet" "a" {
  id = "subnet-09695b3527b656f4a" # us-east-1a, 172.31.0.0/20
}

data "aws_subnet" "b" {
  id = "subnet-0a94aaba3ce6e2623" # us-east-1b, 172.31.80.0/20
}

data "aws_subnet" "f" {
  id = "subnet-0e39a2049aa73ab50" # us-east-1f, 172.31.64.0/20
}

# RDS's DB subnet group is literally named "default" and spans ALL SIX of the
# default VPC's subnets (the three above plus 1c/1d/1e, which nothing else in
# this estate uses directly). See rds.tf.
data "aws_db_subnet_group" "default" {
  name = "default"
}

data "aws_internet_gateway" "default" {
  filter {
    name   = "attachment.vpc-id"
    values = [data.aws_vpc.default.id]
  }
}
# igw-0b96567e7c65c0294, attached, feeds the single default 0.0.0.0/0 route in
# the VPC's main route table (rtb-008c5ab1025c205e2) -- not modeled as a
# resource for the same reason the VPC itself is not: it is unmodified stock
# default-VPC networking.

# ── Security groups ─────────────────────────────────────────────────────

resource "aws_security_group" "alb_public" {
  name        = "otchealth-alb-public"
  description = "Public HTTPS to the OTCHealth gateway"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = null
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "public HTTPS"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "gateway_tasks" {
  name        = "otchealth-gateway-tasks"
  description = "Gateway Fargate tasks: 8080 from ALB only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    protocol        = "tcp"
    from_port       = 8080
    to_port         = 8080
    security_groups = [aws_security_group.alb_public.id]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "dbtools" {
  name        = "otchealth-dbtools"
  description = "Ephemeral DB maintenance tasks"
  vpc_id      = data.aws_vpc.default.id

  # No ingress rules at all, by design -- this SG exists only so dbtools tasks
  # (pgrestore, agentstate-schema) can be RECOGNIZED as the source in the RDS
  # SG's ingress rule below. The tasks reach RDS outbound; RDS never reaches them.

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# The ACCOUNT'S DEFAULT security group for the default VPC. Unlike the three
# above (created for this app), this SG always exists by construction; a
# custom ingress rule was added to it to let dbtools + gateway tasks reach RDS
# on 5432. Terraform's `aws_default_security_group` ADOPTS the existing
# default SG rather than creating a new one, but -- IMPORTANT -- it also fully
# owns its rule set from that point on: any rule present live but NOT listed
# here would show as "to remove" on the first `terraform plan` after import.
# The three rules below (the two 5432 ingress grants + the standard
# self-referencing all-protocol rule) are the COMPLETE, verified live rule set
# as of 2026-08-16 (raw DescribeSecurityGroups XML, not summarized) -- but
# because a missed rule here is destructive on apply (not just incomplete),
# treat this resource with extra care: always read a `terraform plan` diff on
# this specific resource address in full before ever considering apply.
resource "aws_default_security_group" "default" {
  vpc_id = data.aws_vpc.default.id

  # The live SG shows these two grants as one IpPermission (tcp/5432) with two
  # UserIdGroupPairs, EACH carrying its own description. The classic ingress{}
  # block only supports one description per block, so this is modeled as two
  # separate single-source blocks to preserve both descriptions exactly --
  # each maps to its own AuthorizeSecurityGroupIngress call, which is how AWS
  # actually represents them regardless of how DescribeSecurityGroups groups
  # same-port entries for display.
  ingress {
    description     = "otchealth-dbtools restore tasks"
    protocol        = "tcp"
    from_port       = 5432
    to_port         = 5432
    security_groups = [aws_security_group.dbtools.id]
  }

  ingress {
    description     = "gateway tasks"
    protocol        = "tcp"
    from_port       = 5432
    to_port         = 5432
    security_groups = [aws_security_group.gateway_tasks.id]
  }

  # Standard default-SG self-referencing allow-all (present on every default
  # SG that has never been stripped; unrelated to the 5432 grants above).
  ingress {
    protocol  = "-1"
    from_port = 0
    to_port   = 0
    self      = true
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

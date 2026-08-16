/**
 * Network layer -- READ-ONLY data sources, deliberately never `resource` blocks.
 *
 * Verified live 2026-08-16 (EC2 DescribeVpcs/DescribeSubnets/DescribeRouteTables/
 * DescribeInternetGateways/DescribeNatGateways): the whole estate runs in the ACCOUNT'S DEFAULT
 * VPC (vpc-0918944e0647fd0af, 172.31.0.0/16, is_default=true), using its 6 default per-AZ
 * subnets, its default Internet Gateway (igw-0b96567e7c65c0294), and its single "main" route
 * table (172.31.0.0/16 -> local, 0.0.0.0/0 -> the IGW) -- every one of these is an AWS-created
 * default, not something the team provisioned. There are ZERO NAT Gateways (confirmed count: 0)
 * -- every subnet auto-assigns a public IPv4 instead (mapPublicIpOnLaunch=true on all 6), which
 * is how the Fargate tasks (see ecs-gateway.tf) get outbound internet access without one.
 *
 * Modeling a default VPC as a `resource "aws_vpc"` would be WRONG (Terraform would try to manage
 * a resource type that does not match how the VPC was actually created) and importing it would
 * risk a future `terraform destroy` attempting to delete the account's default network. `data`
 * sources are pure reads -- they cannot create, modify, or destroy anything -- which is the
 * correct, zero-risk way to reference an unmanaged default network from the resources that
 * actually live here (the ALB, the ECS service, RDS). If this VPC is ever deliberately brought
 * under Terraform lifecycle (e.g. to manage the default SG's rules, see security-groups.tf), use
 * the purpose-built `aws_default_vpc` / `aws_default_subnet` resource types, which ADOPT the
 * existing default resources instead of creating new ones -- never plain `aws_vpc`/`aws_subnet`.
 */

data "aws_vpc" "main" {
  id = var.vpc_id
}

# The 3 subnets actually used by the ALB and the Fargate tasks (ECS service + every EventBridge
# Scheduler job target, see scheduler.tf) -- one per AZ for the ALB's cross-zone requirement.
data "aws_subnet" "gateway_a" {
  id = "subnet-09695b3527b656f4a" # us-east-1a, 172.31.0.0/20
}

data "aws_subnet" "gateway_b" {
  id = "subnet-0a94aaba3ce6e2623" # us-east-1b, 172.31.80.0/20
}

data "aws_subnet" "gateway_f" {
  id = "subnet-0e39a2049aa73ab50" # us-east-1f, 172.31.64.0/20
}

# A 4th default-VPC subnet that is NOT in the 3 above -- RDS (rds.tf) sits here via the account's
# default DB subnet group, which spans every subnet in the VPC, not just the 3 the ALB/ECS use.
data "aws_subnet" "rds_c" {
  id = "subnet-00d12661411020144" # us-east-1c, 172.31.16.0/20
}

locals {
  # The 3-AZ set the ALB and every Fargate task (service + scheduled jobs) actually run in.
  gateway_subnet_ids = [
    data.aws_subnet.gateway_a.id,
    data.aws_subnet.gateway_b.id,
    data.aws_subnet.gateway_f.id,
  ]
}

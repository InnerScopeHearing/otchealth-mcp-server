/**
 * RDS PostgreSQL. Verified live 2026-08-16 (RDS DescribeDBInstances/DescribeDBSubnetGroups/
 * DescribeDBParameterGroups). db.t4g.micro, postgres 18.3, 20GB gp3 (3000 IOPS / 125 MB/s
 * throughput), MultiAZ=false, PubliclyAccessible=false, StorageEncrypted=true (own KMS key),
 * DeletionProtection=true, 7-day backup retention, IAM DB auth OFF (plain password auth). Tagged
 * purpose=azure-migration. Sits in the VPC's DEFAULT DB subnet group ("default", spans all 6
 * subnets) and the engine's DEFAULT parameter/option groups (default.postgres18,
 * default:postgres-18) -- none of those three are team-created, so none are modeled as
 * `resource` blocks here (see network.tf's header for the identical reasoning re: default VPC
 * constructs). AZ us-east-1c.
 *
 * PASSWORD: RDS's API NEVER returns the master password (verified: DescribeDBInstances has no
 * MasterUserSecret field for this instance -- it does not use AWS Secrets Manager-managed
 * rotation, IAMDatabaseAuthenticationEnabled=false, so it is a manually-set password Terraform
 * cannot discover from any read API). The `password` argument below is an OBVIOUS PLACEHOLDER,
 * not a real credential, and is protected by `lifecycle.ignore_changes` so it is NEVER actually
 * sent to AWS even if this configuration were (against this task's explicit instruction) ever
 * applied -- `terraform import` populates the real drift-tracking state without ever needing this
 * value. The true password lives in Secrets Manager / the SSM parameter store per this repo's
 * existing convention (see the gateway's PG_* secrets, config/env.ts), never in this file.
 */

data "aws_db_subnet_group" "default" {
  name = "default"
}

resource "aws_db_instance" "otchealth_pg" {
  identifier = "otchealth-pg"

  engine         = "postgres"
  engine_version = "18.3"
  instance_class = "db.t4g.micro"

  allocated_storage  = 20
  storage_type       = "gp3"
  iops               = 3000
  storage_throughput = 125
  storage_encrypted  = true
  kms_key_id         = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/618df9b2-7933-41dd-8fbf-5eb29f07075a"

  multi_az            = false
  publicly_accessible = false
  availability_zone   = "us-east-1c"
  network_type        = "IPV4"

  db_subnet_group_name   = data.aws_db_subnet_group.default.name
  vpc_security_group_ids = [aws_default_security_group.default.id]
  parameter_group_name   = "default.postgres18"
  option_group_name      = "default:postgres-18"

  username                            = "otchadmin"
  password                            = "CHANGEME-placeholder-never-applied-real-password-unknowable-via-api"
  iam_database_authentication_enabled = false

  deletion_protection          = true
  backup_retention_period      = 7
  backup_window                = "09:17-09:47"
  maintenance_window           = "sat:06:32-sat:07:02"
  ca_cert_identifier           = "rds-ca-rsa2048-g1"
  auto_minor_version_upgrade   = true
  copy_tags_to_snapshot        = false
  performance_insights_enabled = false
  monitoring_interval          = 0
  engine_lifecycle_support     = "open-source-rds-extended-support"

  tags = {
    purpose = "azure-migration"
  }

  lifecycle {
    ignore_changes = [password]
  }
}

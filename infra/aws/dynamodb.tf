/**
 * DynamoDB. Verified live 2026-08-16 (DynamoDB DescribeTable/ListTagsOfResource) -- ONE table.
 * Single-table design (PK/SK + one GSI on GSI1PK/GSI1SK, ALL projection), PAY_PER_REQUEST,
 * KMS-encrypted (customer-managed key, not the AWS-owned default), deletion protection OFF
 * (unlike RDS, see rds.tf), empty at capture time (ItemCount 0). Tags: Project=ai-customer-service-os,
 * Owner=cto-hyperagent -- this table backs a customer-service system, not the gateway directly.
 */

resource "aws_dynamodb_table" "customer_360" {
  name         = "otchealth-customer-360"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "GSI1PK"
    type = "S"
  }
  attribute {
    name = "GSI1SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/a7f5b1b4-b484-4b07-ba89-2148b3c00cba"
  }

  deletion_protection_enabled = false

  tags = {
    Project = "ai-customer-service-os"
    Owner   = "cto-hyperagent"
  }
}

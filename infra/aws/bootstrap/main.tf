/**
 * The state backend bootstrap. Two logical resources (the bucket and its sub-resources, plus the
 * lock table). See README.md for the full rationale and the apply-once-by-hand sequence. NEITHER
 * RESOURCE HERE HAS EVER BEEN CREATED -- this has only been `fmt` and `validate` checked, exactly
 * like ../infra/aws itself.
 */

resource "aws_s3_bucket" "terraform_state" {
  bucket = var.state_bucket_name

  # Deliberately no `force_destroy = true`: this bucket holds the only copy of every root
  # module's Terraform state. Accidentally destroying it should require manually emptying it
  # first, not a single flag flip.
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket                  = aws_s3_bucket.terraform_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_dynamodb_table" "terraform_locks" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  # Server-side encryption defaults to AWS-owned keys, which is the standard, low-friction choice
  # for a lock table that never holds anything beyond a lock identifier and a short-lived info
  # blob -- no state content is ever written here, only bucket.tfstate lives in S3.
}

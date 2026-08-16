/**
 * S3 buckets. Verified live 2026-08-16 (S3 GetBucketLocation/PublicAccessBlock/Encryption/
 * Versioning/Policy/Lifecycle/Tagging/CORS/OwnershipControls against all 4 buckets in the
 * account). All 4: region us-east-1, PublicAccessBlock fully ON (all 4 sub-settings true),
 * default SSE-S3 (AES256, bucket-key NOT enabled), BucketOwnerEnforced ownership (ACLs
 * disabled), NO bucket policy, NO lifecycle rules, NO tags, NO CORS configuration.
 *
 * VERSIONING DIFFERS PER BUCKET (a real finding beyond the task brief, which described all 4
 * uniformly): otchealth-brain-dr, otchealth-finance-legal-dr, and otchealth-legal-personal-dr all
 * have versioning ENABLED; otchealth-build does NOT (versioning was never turned on -- the
 * empty <VersioningConfiguration/> response, not "Suspended").
 */

locals {
  dr_buckets = {
    brain_dr          = "otchealth-brain-dr-55c84f6b"
    finance_legal_dr  = "otchealth-finance-legal-dr-55c84f6b"
    legal_personal_dr = "otchealth-legal-personal-dr-55c84f6b"
  }
}

resource "aws_s3_bucket" "brain_dr" {
  bucket = local.dr_buckets.brain_dr
}

resource "aws_s3_bucket" "finance_legal_dr" {
  bucket = local.dr_buckets.finance_legal_dr
}

resource "aws_s3_bucket" "legal_personal_dr" {
  bucket = local.dr_buckets.legal_personal_dr
}

resource "aws_s3_bucket" "build" {
  bucket = "otchealth-build-55c84f6b"
}

# --- Public Access Block: fully on, all 4 buckets, identical ---
resource "aws_s3_bucket_public_access_block" "brain_dr" {
  bucket                  = aws_s3_bucket.brain_dr.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "finance_legal_dr" {
  bucket                  = aws_s3_bucket.finance_legal_dr.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "legal_personal_dr" {
  bucket                  = aws_s3_bucket.legal_personal_dr.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "build" {
  bucket                  = aws_s3_bucket.build.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- Default encryption: SSE-S3 (AES256), bucket-key disabled, all 4 buckets, identical ---
resource "aws_s3_bucket_server_side_encryption_configuration" "brain_dr" {
  bucket = aws_s3_bucket.brain_dr.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = false
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "finance_legal_dr" {
  bucket = aws_s3_bucket.finance_legal_dr.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = false
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "legal_personal_dr" {
  bucket = aws_s3_bucket.legal_personal_dr.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = false
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "build" {
  bucket = aws_s3_bucket.build.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = false
  }
}

# --- Ownership controls: BucketOwnerEnforced (ACLs disabled), all 4 ---
resource "aws_s3_bucket_ownership_controls" "brain_dr" {
  bucket = aws_s3_bucket.brain_dr.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_ownership_controls" "finance_legal_dr" {
  bucket = aws_s3_bucket.finance_legal_dr.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_ownership_controls" "legal_personal_dr" {
  bucket = aws_s3_bucket.legal_personal_dr.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_ownership_controls" "build" {
  bucket = aws_s3_bucket.build.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

# --- Versioning: ENABLED on the 3 DR buckets, NEVER SET on build (see file header) ---
resource "aws_s3_bucket_versioning" "brain_dr" {
  bucket = aws_s3_bucket.brain_dr.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_versioning" "finance_legal_dr" {
  bucket = aws_s3_bucket.finance_legal_dr.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_versioning" "legal_personal_dr" {
  bucket = aws_s3_bucket.legal_personal_dr.id
  versioning_configuration { status = "Enabled" }
}

# NOTE: no aws_s3_bucket_versioning resource for `build` -- its versioning was never enabled.
# Adding one with status="Enabled" would be a REAL CHANGE (this bucket receives CodeBuild source
# zips, see codebuild.tf; deliberately left unmanaged here rather than guessed at).

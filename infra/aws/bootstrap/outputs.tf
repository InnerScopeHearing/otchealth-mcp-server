output "terraform_state_bucket" {
  description = "Feed this into infra/aws/backend.tf's `bucket` argument once this module has actually been applied."
  value       = aws_s3_bucket.terraform_state.id
}

output "terraform_lock_table" {
  description = "Feed this into infra/aws/backend.tf's `dynamodb_table` argument once this module has actually been applied."
  value       = aws_dynamodb_table.terraform_locks.name
}

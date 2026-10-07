output "state_bucket_name" {
  description = "Dedicated Godiffy S3 bucket used for Terraform state."
  value       = aws_s3_bucket.state.bucket
}

output "state_bucket_arn" {
  description = "ARN of the Godiffy state bucket for future scoped backend IAM policies."
  value       = aws_s3_bucket.state.arn
}

output "aws_account_id" {
  description = "The only AWS account this bootstrap root is permitted to use."
  value       = local.aws_account_id
}

output "aws_region" {
  description = "Region of the Godiffy state bucket."
  value       = local.aws_region
}

output "state_keys" {
  description = "Separate S3 state object keys for bootstrap, development, and production."
  value       = local.state_keys
}

output "lock_keys" {
  description = "Native S3 lock-file keys; future backend IAM policies need narrowly scoped delete access here."
  value       = { for environment, key in local.state_keys : environment => "${key}.tflock" }
}

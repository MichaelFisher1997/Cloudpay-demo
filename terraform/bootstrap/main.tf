terraform {
  required_version = "~> 1.16.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.67.0"
    }
  }
}

provider "aws" {
  region              = local.aws_region
  allowed_account_ids = [local.aws_account_id]

  default_tags {
    tags = local.tags
  }
}

locals {
  # This bootstrap root intentionally has a fixed deployment target.
  # Changing account, region, or project requires a reviewed code change.
  aws_account_id = "218549829565"
  aws_region     = "eu-west-2"
  project        = "godiffy"

  state_bucket_name = "${local.project}-terraform-state-${local.aws_account_id}-${local.aws_region}"
  state_bucket_arn  = "arn:aws:s3:::${local.state_bucket_name}"

  state_keys = {
    bootstrap = "${local.project}/bootstrap/terraform.tfstate"
    dev       = "${local.project}/dev/terraform.tfstate"
    prod      = "${local.project}/prod/terraform.tfstate"
  }

  tags = {
    Project     = local.project
    Environment = "bootstrap"
    ManagedBy   = "terraform"
    Purpose     = "cloudpay-technical-assessment"
  }
}

resource "aws_s3_bucket" "state" {
  bucket        = local.state_bucket_name
  force_destroy = false

  tags = merge(local.tags, {
    Name = local.state_bucket_name
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

    # Explicitly retain AWS's default block on customer-provided encryption keys.
    blocked_encryption_types = ["SSE-C"]
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      # This wildcard is a denial of insecure access, not a permission grant.
      Action   = "s3:*"
      Resource = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
      Condition = {
        Bool = {
          "aws:SecureTransport"       = "false"
          "aws:PrincipalIsAWSService" = "false"
        }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.state]
}

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

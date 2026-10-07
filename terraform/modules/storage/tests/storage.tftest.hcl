mock_provider "aws" {}
variables {
  name            = "godiffy-dev"
  account_id      = "218549829565"
  origin          = "http://godiffy-dev.example.invalid"
  enable_alb_logs = false
  tags            = { Project = "godiffy", Environment = "dev", ManagedBy = "terraform", Purpose = "cloudpay-technical-assessment" }
}
run "private_versioned_browser_storage" {
  command = apply
  assert {
    condition = (
      !aws_s3_bucket.images.force_destroy &&
      aws_s3_bucket_public_access_block.images.block_public_acls &&
      aws_s3_bucket_public_access_block.images.block_public_policy &&
      aws_s3_bucket_public_access_block.images.ignore_public_acls &&
      aws_s3_bucket_public_access_block.images.restrict_public_buckets &&
      one(aws_s3_bucket_versioning.images.versioning_configuration).status == "Enabled" &&
      one(aws_s3_bucket_ownership_controls.images.rule).object_ownership == "BucketOwnerEnforced"
    )
    error_message = "Images need private, ACL-disabled, versioned storage without forced emptying."
  }
  assert {
    condition = (
      one(aws_s3_bucket_cors_configuration.images.cors_rule).allowed_origins == toset([var.origin]) &&
      contains(one(aws_s3_bucket_cors_configuration.images.cors_rule).allowed_methods, "POST") &&
      length(jsondecode(aws_s3_bucket_policy.images.policy).Statement) == 1 &&
      !strcontains(aws_s3_bucket_policy.images.policy, "aws:SourceVpce")
    )
    error_message = "Direct browser access needs one exact CORS origin without a blanket VPC-only deny."
  }
  assert {
    condition = alltrue([
      for rule in aws_s3_bucket_lifecycle_configuration.images.rule : one(rule.filter).prefix == "pending/"
    ])
    error_message = "Cleanup must never blindly expire pinned versions under images/."
  }
}
run "prod_alb_logs" {
  command = apply
  variables {
    name            = "godiffy-prod"
    origin          = "https://godiffy.com"
    enable_alb_logs = true
  }
  assert {
    condition = (
      length(aws_s3_bucket.alb_logs) == 1 &&
      jsondecode(aws_s3_bucket_policy.alb_logs[0].policy).Statement[0].Principal.Service == "logdelivery.elasticloadbalancing.amazonaws.com"
    )
    error_message = "Prod ALB logs need a dedicated bucket with service-scoped delivery permission."
  }
}

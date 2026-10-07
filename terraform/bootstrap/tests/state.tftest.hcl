# Every run uses a mock provider and plans only: these tests make no AWS changes.
mock_provider "aws" {}

run "bucket_security" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "godiffy-terraform-state-218549829565-eu-west-2"
    error_message = "The state bucket must remain dedicated to Godiffy in the approved account and region."
  }

  assert {
    condition     = aws_s3_bucket.state.force_destroy == false
    error_message = "Terraform must not recursively delete state objects."
  }

  assert {
    condition = (
      aws_s3_bucket.state.tags.Project == "godiffy" &&
      aws_s3_bucket.state.tags.Environment == "bootstrap" &&
      aws_s3_bucket.state.tags.ManagedBy == "terraform" &&
      aws_s3_bucket.state.tags.Purpose == "cloudpay-technical-assessment"
    )
    error_message = "State infrastructure must have the agreed Godiffy bootstrap tags."
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.state.block_public_acls &&
      aws_s3_bucket_public_access_block.state.block_public_policy &&
      aws_s3_bucket_public_access_block.state.ignore_public_acls &&
      aws_s3_bucket_public_access_block.state.restrict_public_buckets
    )
    error_message = "All four S3 Block Public Access settings must be enabled."
  }

  assert {
    condition     = one(aws_s3_bucket_ownership_controls.state.rule).object_ownership == "BucketOwnerEnforced"
    error_message = "ACLs must be disabled through Bucket Owner Enforced ownership."
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "The state bucket must default to SSE-S3 encryption."
  }

  assert {
    condition     = toset(one(aws_s3_bucket_server_side_encryption_configuration.state.rule).blocked_encryption_types) == toset(["SSE-C"])
    error_message = "Customer-provided encryption keys must remain blocked for state objects."
  }

  assert {
    condition     = one(aws_s3_bucket_versioning.state.versioning_configuration).status == "Enabled"
    error_message = "State versioning must be enabled for recovery."
  }
}

run "transport_policy" {
  command = plan

  assert {
    condition = (
      length(jsondecode(aws_s3_bucket_policy.state.policy).Statement) == 1 &&
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Effect == "Deny" &&
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Principal == "*" &&
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Action == "s3:*"
    )
    error_message = "The bucket policy must deny insecure access without granting anyone additional access."
  }

  assert {
    condition = toset(jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Resource) == toset([
      "arn:aws:s3:::godiffy-terraform-state-218549829565-eu-west-2",
      "arn:aws:s3:::godiffy-terraform-state-218549829565-eu-west-2/*",
    ])
    error_message = "The bucket policy must not reference any other bucket."
  }

  assert {
    condition = (
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false" &&
      jsondecode(aws_s3_bucket_policy.state.policy).Statement[0].Condition.Bool["aws:PrincipalIsAWSService"] == "false"
    )
    error_message = "HTTP must be denied, preserving AWS service-principal compatibility."
  }
}

run "separate_backend_keys" {
  command = plan

  assert {
    condition = output.state_keys == {
      bootstrap = "godiffy/bootstrap/terraform.tfstate"
      dev       = "godiffy/dev/terraform.tfstate"
      prod      = "godiffy/prod/terraform.tfstate"
    }
    error_message = "Bootstrap, dev, and prod must have separate Godiffy state keys."
  }

  assert {
    condition = alltrue([
      for environment, key in output.state_keys : output.lock_keys[environment] == "${key}.tflock"
    ])
    error_message = "Every state must have its own native S3 lock-file path."
  }

  assert {
    condition = alltrue([
      for environment, path in {
        bootstrap = "${path.module}/backend.hcl"
        dev       = "${path.module}/../environments/dev/backend.hcl"
        prod      = "${path.module}/../environments/prod/backend.hcl"
        } : (
        length(regexall("bucket\\s*=\\s*\"${aws_s3_bucket.state.bucket}\"", file(path))) == 1 &&
        length(regexall("key\\s*=\\s*\"${output.state_keys[environment]}\"", file(path))) == 1 &&
        length(regexall("region\\s*=\\s*\"eu-west-2\"", file(path))) == 1 &&
        length(regexall("encrypt\\s*=\\s*true", file(path))) == 1 &&
        length(regexall("use_lockfile\\s*=\\s*true", file(path))) == 1 &&
        length(regexall("allowed_account_ids\\s*=\\s*\\[\"218549829565\"\\]", file(path))) == 1
      )
    ])
    error_message = "Every backend configuration must use its own key, the approved target, encryption, and native locking."
  }
}

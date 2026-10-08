mock_provider "aws" {}
# Import reads must be explicitly overridden; never contact IAM in offline tests.
override_resource {
  target = aws_iam_policy.ci_scopes
  values = { arn = "arn:aws:iam::218549829565:policy/godiffy-dev-mock-only" }
}
override_resource { target = aws_iam_role_policy_attachment.dev_ci }
run "dev_foundations_only" {
  command = plan
  assert {
    condition = (
      output.deployment.environment == "dev" && output.deployment.account_id == "218549829565" &&
      output.deployment.region == "eu-west-2" && !output.deployment.service_enabled &&
      length(output.deployment.task_subnet_ids) == 1 &&
      output.deployment.cluster_name == "godiffy-dev-cluster" &&
      length(output.deployment.job_task_definitions) == 0
    )
    error_message = "Default dev root must be dedicated, foundation-only, without a placeholder release."
  }
}

run "recorded_dev_release_preserves_existing_history" {
  command = plan
  variables {
    release = jsondecode(file("release.tfvars.json")).release
  }
  assert {
    condition = (
      output.deployment.service_enabled &&
      output.deployment.image_digest == "sha256:0b9490fbfef66443dbca66960709e4a7c2510890b50396423fcaf369915843d1" &&
      length(output.deployment.retained_image_digests) == 3 &&
      length(output.deployment.bootstrap_image_digests) == 1 &&
      length(output.deployment.job_task_definitions) == 2 &&
      !var.release.bootstrap_enabled
    )
    error_message = "The recorded release must preserve existing task history without restoring initialization privileges."
  }
}

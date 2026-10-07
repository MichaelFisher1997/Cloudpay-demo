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

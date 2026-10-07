mock_provider "aws" {}
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

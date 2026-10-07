mock_provider "aws" {}
run "prod_not_activated" {
  command = plan
  assert {
    condition = (
      output.deployment.environment == "prod" && !output.deployment.service_enabled &&
      output.deployment.application_origin == "https://godiffy.com" &&
      length(output.deployment.task_subnet_ids) == 2 &&
      output.deployment.database_identifier == "godiffy-prod-postgres" &&
      length(output.deployment.job_task_definitions) == 0
    )
    error_message = "Default production is a two-AZ design, not an authorised service deployment."
  }
}

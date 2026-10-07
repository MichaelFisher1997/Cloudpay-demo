mock_provider "aws" {}
variables {
  environment     = "prod"
  app_url         = "https://godiffy.com"
  certificate_arn = "arn:aws:acm:eu-west-2:218549829565:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  alarm_email     = "operations@example.invalid"
  release = {
    image_digest    = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    service_enabled = true
    database_ready  = true
  }
}
run "reject_unreviewed_production" {
  command         = plan
  expect_failures = [var.release]
}
run "reviewed_production_shape_mock_only" {
  command = plan
  variables { production_reviewed = true }
  assert {
    condition = (
      output.deployment.service_enabled && length(output.deployment.task_subnet_ids) == 2 &&
      output.deployment.alarm_email_supplied && output.deployment.application_origin == "https://godiffy.com"
    )
    error_message = "The reviewed production shape must have two task AZs, HTTPS and an alert recipient."
  }
}

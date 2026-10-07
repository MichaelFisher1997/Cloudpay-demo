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
run "production_root_preserves_live_clerk_inputs" {
  command = plan
  variables {
    production_reviewed = true
    app_url             = "https://gallery.example"
    certificate_arn     = "arn:aws:acm:eu-west-2:218549829565:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    alarm_email         = "operations@example.invalid"
    release = {
      image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", service_enabled = true, database_ready = true
      clerk_auth = {
        publishable_key = "pk_live_${base64encode("clerk.gallery.example$")}"
        issuer          = "https://clerk.gallery.example"
        jwt_key         = "-----BEGIN PUBLIC KEY-----\nmock-only-not-a-real-key"
        allowed_emails  = ["owner@example.invalid"]
      }
    }
  }
  assert {
    condition = (
      output.deployment.service_enabled &&
      output.deployment.application_origin == "https://gallery.example" &&
      var.release.clerk_auth.issuer == "https://clerk.gallery.example"
    )
    error_message = "The production root must retain Clerk configuration all the way to the task module."
  }
}

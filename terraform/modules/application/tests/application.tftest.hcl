mock_provider "aws" {
  mock_resource "aws_ecr_repository" {
    defaults = {
      repository_url = "218549829565.dkr.ecr.eu-west-2.amazonaws.com/godiffy-dev-application"
      arn            = "arn:aws:ecr:eu-west-2:218549829565:repository/godiffy-dev-application"
    }
  }
  mock_resource "aws_lb" {
    defaults = {
      dns_name = "godiffy-dev.example.invalid"
      arn      = "arn:aws:elasticloadbalancing:eu-west-2:218549829565:loadbalancer/app/godiffy-dev-alb/1234567890123456"
    }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-2:218549829565:targetgroup/godiffy-dev-app/1234567890123456" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::218549829565:role/godiffy-dev-test" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-west-2:218549829565:log-group:/ecs/godiffy-dev-application" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { id = "arn:aws:ecs:eu-west-2:218549829565:cluster/godiffy-dev-cluster" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:eu-west-2:218549829565:task-definition/godiffy-dev-web:1" }
  }
}
variables {
  name       = "godiffy-dev"
  account_id = "218549829565"
  production = false
  network = {
    vpc_id          = "vpc-11111111", public_subnet_ids = ["subnet-11111111", "subnet-22222222"],
    task_subnet_ids = ["subnet-33333333"], alb_sg_id = "sg-11111111", task_sg_id = "sg-22222222"
  }
  database = {
    host                 = "godiffy-dev.example.invalid"
    runtime_secret_arn   = "arn:aws:secretsmanager:eu-west-2:218549829565:secret:godiffy-dev-runtime-abcdef"
    migration_secret_arn = "arn:aws:secretsmanager:eu-west-2:218549829565:secret:godiffy-dev-migration-abcdef"
    master_secret_arn    = "arn:aws:secretsmanager:eu-west-2:218549829565:secret:rds!db-godiffy-dev-abcdef"
  }
  image_bucket_name = "godiffy-dev-images-218549829565-eu-west-2"
  image_bucket_arn  = "arn:aws:s3:::godiffy-dev-images-218549829565-eu-west-2"
  tags              = { Project = "godiffy", Environment = "dev", ManagedBy = "terraform", Purpose = "cloudpay-technical-assessment" }
}

run "foundations_without_fake_image" {
  command = apply
  assert {
    condition = (
      length(aws_ecs_task_definition.web) == 0 && length(aws_ecs_service.this) == 0 &&
      length(aws_ecs_task_definition.job) == 0 && length(aws_iam_role.bootstrap) == 0 &&
      aws_ecr_repository.this.image_tag_mutability == "IMMUTABLE" &&
      one(aws_ecr_repository.this.image_scanning_configuration).scan_on_push
    )
    error_message = "Foundations must not deploy a placeholder image/service or grant standing DB master access."
  }
  assert {
    condition     = aws_lb.this.xff_header_processing_mode == "append" && !aws_lb.this.enable_xff_client_port
    error_message = "The auth trusted-proxy contract requires ALB append mode without client ports."
  }
  assert {
    condition = (
      jsondecode(aws_iam_role_policy.runtime.policy).Statement[0].Resource == var.database.runtime_secret_arn &&
      !strcontains(aws_iam_role_policy.runtime.policy, var.database.master_secret_arn) &&
      !strcontains(aws_iam_role_policy.runtime.policy, var.database.migration_secret_arn) &&
      !strcontains(aws_iam_role_policy.execution.policy, "secretsmanager:")
    )
    error_message = "Runtime/execution roles must not acquire master/migration secrets."
  }
}

run "dev_service_immutable_private" {
  command = apply
  variables {
    # Mock-only digest, not a deployable image. Never copy it into real tfvars.
    release = { image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", service_enabled = true, database_ready = true }
  }
  assert {
    condition = (
      !one(aws_ecs_service.this[0].network_configuration).assign_public_ip &&
      aws_ecs_service.this[0].desired_count == 1 &&
      one(aws_ecs_service.this[0].deployment_circuit_breaker).rollback &&
      jsondecode(aws_ecs_task_definition.web[var.release.image_digest].container_definitions)[0].readonlyRootFilesystem &&
      strcontains(jsondecode(aws_ecs_task_definition.web[var.release.image_digest].container_definitions)[0].image, "@sha256:") &&
      aws_appautoscaling_target.this[0].min_capacity == 1
    )
    error_message = "Dev tasks must remain private, non-root/read-only, rollback-enabled and digest-pinned."
  }
}

run "reject_mutable_image" {
  command = plan
  variables { release = { image_digest = "latest" } }
  expect_failures = [var.release]
}
run "bootstrap_restricted_and_retained" {
  command = plan
  variables {
    release = { image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", service_enabled = true, database_ready = true, bootstrap_retained = true }
    task_permissions_boundaries = {
      runtime = "arn:aws:iam::218549829565:policy/godiffy-dev-boundary-runtime"
    }
  }
  assert {
    condition = (
      length(aws_iam_role.bootstrap) == 1 && contains(keys(aws_ecs_task_definition.job), "${var.release.image_digest}/bootstrap") &&
      jsondecode(aws_iam_role.bootstrap[0].assume_role_policy).Statement[0].Effect == "Deny" &&
      jsondecode(aws_iam_role_policy.bootstrap[0].policy).Statement[0].Effect == "Deny" &&
      aws_iam_role.runtime.permissions_boundary == "arn:aws:iam::218549829565:policy/godiffy-dev-boundary-runtime"
    )
    error_message = "Bootstrap retirement must restrict privileges/trust in place, never delete the role or definitions."
  }
}
run "new_image_retains_previous_definitions" {
  command = plan
  variables {
    release = {
      image_digest           = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      retained_image_digests = ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
      bootstrap_retained     = true, service_enabled = true, database_ready = true
    }
  }
  assert {
    condition = (
      length(aws_ecs_task_definition.web) == 2 && length(aws_ecs_task_definition.job) == 6 &&
      contains(keys(aws_ecs_task_definition.web), "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") &&
      contains(keys(aws_ecs_task_definition.web), var.release.image_digest)
    )
    error_message = "New images must retain earlier immutable definitions without deletion."
  }
}
run "reject_service_before_migrations" {
  command = plan
  variables {
    release = { image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", service_enabled = true }
  }
  expect_failures = [var.release]
}
run "reject_production_http" {
  command = plan
  variables {
    production = true
    release    = { image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", service_enabled = true, database_ready = true }
  }
  expect_failures = [aws_ecs_service.this]
}

run "https_before_redirect" {
  command = plan
  variables {
    certificate_arn = "arn:aws:acm:eu-west-2:218549829565:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    app_url         = "https://dev.godiffy.com"
  }
  assert {
    condition = (
      length(aws_lb_listener.https) == 1 &&
      one(aws_lb_listener.http[0].default_action).type == "forward"
    )
    error_message = "Adding a certificate must not activate redirects before DNS/HTTPS verification."
  }
}
run "redirect_only_after_dns" {
  command = plan
  variables {
    certificate_arn        = "arn:aws:acm:eu-west-2:218549829565:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    app_url                = "https://dev.godiffy.com"
    https_redirect_enabled = true
  }
  assert {
    condition = (
      one(aws_lb_listener.http[0].default_action).type == "redirect" &&
      one(one(aws_lb_listener.http[0].default_action).redirect).host == "dev.godiffy.com"
    )
    error_message = "Approved redirects must target the custom hostname, not the ALB hostname."
  }
}
run "reject_prod_email_only_registration" {
  command = plan
  variables {
    production     = true
    invited_emails = ["test@example.invalid"]
  }
  expect_failures = [var.invited_emails]
}

run "reject_custom_origin_without_listener" {
  command = plan
  variables {
    app_url = "https://dev.godiffy.com"
    release = { image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", service_enabled = true, database_ready = true }
  }
  expect_failures = [var.release]
}

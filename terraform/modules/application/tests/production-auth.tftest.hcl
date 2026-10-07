# All digests, hosts and keys below are mock fixtures, never deployment inputs.
mock_provider "aws" {
  mock_resource "aws_ecr_repository" {
    defaults = {
      repository_url = "218549829565.dkr.ecr.eu-west-2.amazonaws.com/godiffy-prod-application"
      arn            = "arn:aws:ecr:eu-west-2:218549829565:repository/godiffy-prod-application"
    }
  }
  mock_resource "aws_lb" {
    defaults = {
      dns_name = "godiffy-prod.example.invalid"
      arn      = "arn:aws:elasticloadbalancing:eu-west-2:218549829565:loadbalancer/app/godiffy-prod-alb/1234567890123456"
    }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-2:218549829565:targetgroup/godiffy-prod-app/1234567890123456" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::218549829565:role/godiffy-prod-test" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-west-2:218549829565:log-group:/ecs/godiffy-prod-application" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { id = "arn:aws:ecs:eu-west-2:218549829565:cluster/godiffy-prod-cluster" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:eu-west-2:218549829565:task-definition/godiffy-prod-web:1" }
  }
}
variables {
  name              = "godiffy-prod"
  account_id        = "218549829565"
  production        = true
  app_url           = "https://gallery.example"
  certificate_arn   = "arn:aws:acm:eu-west-2:218549829565:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  image_bucket_name = "godiffy-prod-images-218549829565-eu-west-2"
  image_bucket_arn  = "arn:aws:s3:::godiffy-prod-images-218549829565-eu-west-2"
  tags              = { Project = "godiffy", Environment = "prod", ManagedBy = "terraform", Purpose = "cloudpay-technical-assessment" }
  network = {
    vpc_id          = "vpc-11111111", public_subnet_ids = ["subnet-11111111", "subnet-22222222"],
    task_subnet_ids = ["subnet-33333333", "subnet-44444444"], alb_sg_id = "sg-11111111", task_sg_id = "sg-22222222"
  }
  database = {
    host                 = "godiffy-prod.example.invalid"
    runtime_secret_arn   = "arn:aws:secretsmanager:eu-west-2:218549829565:secret:godiffy-prod-runtime-abcdef"
    migration_secret_arn = "arn:aws:secretsmanager:eu-west-2:218549829565:secret:godiffy-prod-migration-abcdef"
    master_secret_arn    = "arn:aws:secretsmanager:eu-west-2:218549829565:secret:rds!db-godiffy-prod-abcdef"
  }
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

run "production_live_auth_private_ha_and_https" {
  command = apply # Mock provider only; never calls AWS.
  assert {
    condition = (
      aws_ecs_service.this[0].desired_count == 2 &&
      length(one(aws_ecs_service.this[0].network_configuration).subnets) == 2 &&
      !one(aws_ecs_service.this[0].network_configuration).assign_public_ip &&
      aws_ecs_service.this[0].availability_zone_rebalancing == "ENABLED" &&
      aws_appautoscaling_target.this[0].min_capacity == 2 &&
      aws_appautoscaling_target.this[0].max_capacity == 4 &&
      one(aws_lb_listener.http[0].default_action).type == "fixed-response" &&
      length(aws_lb_listener.https) == 1
    )
    error_message = "Production needs private multi-AZ replicas and HTTPS; plaintext must not reach the app."
  }
  assert {
    condition = (
      contains(jsondecode(aws_ecs_task_definition.web[var.release.image_digest].container_definitions)[0].environment, { name = "CLERK_PUBLISHABLE_KEY", value = var.release.clerk_auth.publishable_key }) &&
      contains(jsondecode(aws_ecs_task_definition.web[var.release.image_digest].container_definitions)[0].environment, { name = "CLERK_ISSUER", value = var.release.clerk_auth.issuer }) &&
      contains(jsondecode(aws_ecs_task_definition.web[var.release.image_digest].container_definitions)[0].environment, { name = "CLERK_JWT_KEY", value = var.release.clerk_auth.jwt_key }) &&
      contains(jsondecode(aws_ecs_task_definition.web[var.release.image_digest].container_definitions)[0].environment, { name = "CLERK_ALLOWED_EMAILS", value = "owner@example.invalid" }) &&
      contains(jsondecode(aws_ecs_task_definition.web[var.release.image_digest].container_definitions)[0].environment, { name = "ALLOW_INSECURE_HTTP", value = "false" }) &&
      !strcontains(aws_ecs_task_definition.web[var.release.image_digest].container_definitions, "CLERK_SECRET_KEY")
    )
    error_message = "Production must receive explicit live public configuration without a Clerk secret or HTTP bypass."
  }
}

run "reject_production_missing_auth" {
  command = plan
  variables {
    release = { image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", service_enabled = true, database_ready = true }
  }
  expect_failures = [var.release]
}

run "reject_production_development_auth" {
  command = plan
  variables {
    release = {
      image_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", service_enabled = true, database_ready = true
      clerk_auth   = { publishable_key = "pk_test_${base64encode("mock.clerk.accounts.dev$")}", issuer = "https://mock.clerk.accounts.dev", jwt_key = "-----BEGIN PUBLIC KEY-----\nmock", allowed_emails = ["owner@example.invalid"] }
    }
  }
  expect_failures = [var.release]
}

run "reject_live_prefix_with_development_issuer" {
  command = plan
  variables {
    release = {
      clerk_auth = { publishable_key = "pk_live_${base64encode("mock.clerk.accounts.dev$")}", issuer = "https://mock.clerk.accounts.dev", jwt_key = "-----BEGIN PUBLIC KEY-----\nmock", allowed_emails = ["owner@example.invalid"] }
    }
  }
  expect_failures = [var.release]
}

run "reject_mismatched_live_key_and_issuer" {
  command = plan
  variables {
    release = {
      clerk_auth = { publishable_key = "pk_live_${base64encode("clerk.other.example$")}", issuer = "https://clerk.gallery.example", jwt_key = "-----BEGIN PUBLIC KEY-----\nmock", allowed_emails = ["owner@example.invalid"] }
    }
  }
  expect_failures = [var.release]
}

run "reject_production_wildcard_access" {
  command = plan
  variables {
    release = {
      clerk_auth = { publishable_key = "pk_live_${base64encode("clerk.gallery.example$")}", issuer = "https://clerk.gallery.example", jwt_key = "-----BEGIN PUBLIC KEY-----\nmock", allowed_emails = ["*@example.invalid"] }
    }
  }
  expect_failures = [var.release]
}

run "reject_production_missing_origin" {
  command = plan
  variables {
    app_url         = null
    certificate_arn = null
  }
  expect_failures = [var.release]
}

run "reject_production_missing_certificate" {
  command = plan
  variables { certificate_arn = null }
  expect_failures = [var.release]
}

run "reject_production_plaintext_origin" {
  command = plan
  variables { app_url = "http://gallery.example" }
  expect_failures = [var.app_url]
}

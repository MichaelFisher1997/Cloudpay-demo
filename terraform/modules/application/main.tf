locals {
  environment     = var.production ? "prod" : "dev"
  release_digests = var.release.image_digest == null ? toset([]) : setunion(toset([var.release.image_digest]), var.release.retained_image_digests)
  release_images  = { for digest in local.release_digests : digest => "${aws_ecr_repository.this.repository_url}@${digest}" }
  origin          = var.app_url != null ? var.app_url : "http://${aws_lb.this.dns_name}"
  log_options = {
    "awslogs-group"         = aws_cloudwatch_log_group.application.name
    "awslogs-region"        = "eu-west-2"
    "awslogs-stream-prefix" = "ecs"
  }
  common_environment = [
    { name = "ENVIRONMENT", value = local.environment },
    { name = "AWS_REGION", value = "eu-west-2" },
    { name = "DATABASE_HOST", value = var.database.host },
    { name = "DATABASE_PORT", value = "5432" },
    { name = "DATABASE_NAME", value = "godiffy" },
  ]
  clerk_environment = var.release.clerk_auth == null ? [] : [
    { name = "CLERK_PUBLISHABLE_KEY", value = var.release.clerk_auth.publishable_key },
    { name = "CLERK_ISSUER", value = var.release.clerk_auth.issuer },
    { name = "CLERK_JWT_KEY", value = var.release.clerk_auth.jwt_key },
    { name = "CLERK_ALLOWED_EMAILS", value = join(",", var.release.clerk_auth.allowed_emails) },
  ]
  job_types = var.release.image_digest == null ? {} : merge(
    { migrate = { role_arn = aws_iam_role.migration.arn } },
    !var.production ? { verify = { role_arn = aws_iam_role.runtime.arn } } : {},
    var.release.bootstrap_enabled || var.release.bootstrap_retained ? { bootstrap = { role_arn = aws_iam_role.bootstrap[0].arn } } : {}
  )
  # Retain old immutable definitions: a new image creates revisions instead of
  # deleting/replacing prior definitions under the current no-deletion approval.
  job_definitions = {
    for job in flatten([
      for digest in local.release_digests : [
        for kind, settings in local.job_types : {
          key = "${digest}/${kind}", kind = kind, image = local.release_images[digest], role_arn = settings.role_arn
        } if kind != "bootstrap" || (var.release.bootstrap_enabled && digest == var.release.image_digest) || contains(var.release.retained_bootstrap_image_digests, digest)
      ]
    ]) : job.key => job
  }
}

resource "aws_ecr_repository" "this" {
  name                 = "${var.name}-application"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
  tags = var.tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name
  policy = jsonencode({ rules = [{
    rulePriority = 1
    description  = "Expire only untagged build artifacts; retain immutable release/rollback tags"
    selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 14 }
    action       = { type = "expire" }
  }] })
}

data "aws_ecr_image" "release" {
  for_each        = local.release_images
  registry_id     = var.account_id
  repository_name = aws_ecr_repository.this.name
  image_digest    = each.key
}

resource "aws_cloudwatch_log_group" "application" {
  name              = "/ecs/${var.name}-application"
  retention_in_days = var.production ? 30 : 7
  tags              = var.tags
}

resource "aws_ecs_cluster" "this" {
  name = "${var.name}-cluster"
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
  tags = var.tags
}

resource "aws_lb" "this" {
  name                             = "${var.name}-alb"
  internal                         = false
  load_balancer_type               = "application"
  ip_address_type                  = "ipv4"
  subnets                          = var.network.public_subnet_ids
  security_groups                  = [var.network.alb_sg_id]
  enable_deletion_protection       = var.production
  drop_invalid_header_fields       = true
  desync_mitigation_mode           = "strictest"
  enable_cross_zone_load_balancing = true
  # Auth rate limiting trusts only the last, ALB-appended client IP (without port).
  xff_header_processing_mode = "append"
  enable_xff_client_port     = false
  idle_timeout               = 60
  dynamic "access_logs" {
    for_each = var.alb_log_bucket == null ? [] : [var.alb_log_bucket]
    content {
      bucket  = access_logs.value
      prefix  = var.name
      enabled = true
    }
  }
  tags = var.tags
}

resource "aws_lb_target_group" "this" {
  name                 = "${var.name}-app"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.network.vpc_id
  deregistration_delay = 30
  health_check {
    enabled             = true
    path                = "/health/ready"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = var.tags
}

resource "aws_lb_listener" "http" {
  count             = !var.production || var.certificate_arn != null ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  dynamic "default_action" {
    for_each = !var.production && !var.https_redirect_enabled ? [1] : []
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.this.arn
    }
  }
  dynamic "default_action" {
    for_each = var.https_redirect_enabled ? [1] : []
    content {
      type = "redirect"
      redirect {
        host        = split("/", var.app_url)[2]
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
  dynamic "default_action" {
    for_each = var.production && !var.https_redirect_enabled ? [1] : []
    content {
      type = "fixed-response"
      fixed_response {
        content_type = "text/plain"
        message_body = "HTTPS required"
        status_code  = "404"
      }
    }
  }
  tags = var.tags
}

resource "aws_lb_listener" "https" {
  count             = var.certificate_arn == null ? 0 : 1
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
  tags = var.tags
}

resource "aws_ecs_task_definition" "web" {
  for_each                 = local.release_images
  family                   = "${var.name}-web"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.runtime.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  # Retained revisions keep their exact prior configuration. Updating auth must
  # create only the new image's revision, not replace historical definitions.
  container_definitions = lookup(var.release.retained_web_containers, each.key, jsonencode([{
    name                   = "web"
    image                  = each.value
    essential              = true
    readonlyRootFilesystem = true
    user                   = "10001:10001"
    portMappings           = [{ containerPort = 3000, protocol = "tcp" }]
    environment = concat(local.common_environment, local.clerk_environment, [
      { name = "IMAGE_BUCKET", value = var.image_bucket_name },
      { name = "DATABASE_SECRET_ARN", value = var.database.runtime_secret_arn },
      { name = "APP_URL", value = local.origin },
      { name = "ALLOW_INSECURE_HTTP", value = !var.production && var.certificate_arn == null ? "true" : "false" },
      # Historical password-auth setting, unused by Clerk; retain for old definitions.
      { name = "INVITED_EMAILS", value = join(",", var.invited_emails) },
    ])
    logConfiguration = { logDriver = "awslogs", options = local.log_options }
    healthCheck = {
      command     = ["CMD-SHELL", "bun -e 'fetch(\"http://127.0.0.1:3000/health/live\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    linuxParameters = { initProcessEnabled = true }
    stopTimeout     = 30
  }]))
  tags       = var.tags
  depends_on = [data.aws_ecr_image.release]
}

resource "aws_ecs_task_definition" "job" {
  for_each                 = local.job_definitions
  family                   = "${var.name}-${each.value.kind}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = each.value.role_arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name                   = each.value.kind
    image                  = each.value.image
    command                = ["bun", "run", "db:${each.value.kind}"]
    essential              = true
    readonlyRootFilesystem = true
    user                   = "10001:10001"
    environment = concat(local.common_environment, [
      { name = "MIGRATION_SECRET_ARN", value = var.database.migration_secret_arn },
      ], each.value.kind == "bootstrap" ? [
      { name = "DATABASE_SECRET_ARN", value = var.database.runtime_secret_arn },
      { name = "MASTER_SECRET_ARN", value = var.database.master_secret_arn },
      ] : [], each.value.kind == "verify" ? [
      { name = "DATABASE_SECRET_ARN", value = var.database.runtime_secret_arn },
      { name = "MASTER_SECRET_ARN", value = var.database.master_secret_arn },
      { name = "APP_URL", value = local.origin },
      { name = "IMAGE_BUCKET", value = var.image_bucket_name },
      { name = "ALLOW_INSECURE_HTTP", value = var.production ? "false" : "true" },
    ] : [])
    logConfiguration = { logDriver = "awslogs", options = local.log_options }
    linuxParameters  = { initProcessEnabled = true }
    stopTimeout      = 30
  }])
  tags       = var.tags
  depends_on = [data.aws_ecr_image.release, aws_iam_role_policy.execution, aws_iam_role_policy.migration, aws_iam_role_policy.bootstrap]
}

resource "aws_ecs_service" "this" {
  count                              = var.release.service_enabled ? 1 : 0
  name                               = "${var.name}-web"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.web[var.release.image_digest].arn
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  desired_count                      = var.production ? 2 : 1
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  availability_zone_rebalancing      = var.production ? "ENABLED" : "DISABLED"
  health_check_grace_period_seconds  = 60
  wait_for_steady_state              = true
  enable_execute_command             = false
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.network.task_subnet_ids
    security_groups  = [var.network.task_sg_id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = "web"
    container_port   = 3000
  }
  lifecycle {
    # Scaling owns replica count. Terraform owns image, IAM, task definition and service settings.
    ignore_changes = [desired_count]
    precondition {
      condition     = !var.production || var.certificate_arn != null
      error_message = "Production service cannot be activated without approved HTTPS."
    }
  }
  depends_on = [
    aws_lb_listener.http, aws_lb_listener.https,
    aws_iam_role_policy.execution, aws_iam_role_policy.runtime,
  ]
  tags = var.tags
}

resource "aws_appautoscaling_target" "this" {
  count              = var.release.service_enabled ? 1 : 0
  min_capacity       = var.production ? 2 : 1
  max_capacity       = var.production ? 4 : 2
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
  tags               = var.tags
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = var.release.service_enabled ? 1 : 0
  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

locals {
  task_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
        # ECS currently requires the account-scoped source ARN wildcard, not a cluster ARN.
        ArnLike = { "aws:SourceArn" = "arn:aws:ecs:eu-west-2:${var.account_id}:*" }
      }
    }]
  })
}

resource "aws_iam_role" "execution" {
  name                 = "${var.name}-execution"
  assume_role_policy   = local.task_trust
  tags                 = var.tags
  permissions_boundary = lookup(var.task_permissions_boundaries, "execution", null)
}

resource "aws_iam_role_policy" "execution" {
  name = "${var.name}-image-and-logs"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "RegionalECRAuthentication"
        Effect    = "Allow"
        Action    = "ecr:GetAuthorizationToken"
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = "eu-west-2" } }
      },
      {
        Sid      = "PullOnlyGodiffyImages"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = aws_ecr_repository.this.arn
      },
      {
        Sid      = "WriteOnlyGodiffyLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.application.arn}:*"
      },
    ]
  })
}

resource "aws_iam_role" "runtime" {
  name                 = "${var.name}-runtime"
  assume_role_policy   = local.task_trust
  tags                 = var.tags
  permissions_boundary = lookup(var.task_permissions_boundaries, "runtime", null)
}

resource "aws_iam_role_policy" "runtime" {
  name = "${var.name}-runtime-data"
  role = aws_iam_role.runtime.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadRestrictedDBSecret"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = var.database.runtime_secret_arn
      },
      {
        Sid      = "StageAndVerifyUploads"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${var.image_bucket_arn}/pending/*"
      },
      {
        Sid      = "PromoteDownloadAndDeletePinnedVersions"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObjectVersion", "s3:DeleteObjectVersion"]
        Resource = "${var.image_bucket_arn}/images/*"
      },
    ]
  })
}

resource "aws_iam_role" "migration" {
  name                 = "${var.name}-migration"
  assume_role_policy   = local.task_trust
  tags                 = var.tags
  permissions_boundary = lookup(var.task_permissions_boundaries, "migration", null)
}

resource "aws_iam_role_policy" "migration" {
  name = "${var.name}-schema-secret"
  role = aws_iam_role.migration.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = var.database.migration_secret_arn
    }]
  })
}

resource "aws_iam_role" "bootstrap" {
  count = var.release.bootstrap_enabled || var.release.bootstrap_retained ? 1 : 0
  name  = "${var.name}-bootstrap"
  assume_role_policy = var.release.bootstrap_enabled ? local.task_trust : jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Deny", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags                 = var.tags
  permissions_boundary = lookup(var.task_permissions_boundaries, "bootstrap", null)
}

resource "aws_iam_role_policy" "bootstrap" {
  count = var.release.bootstrap_enabled || var.release.bootstrap_retained ? 1 : 0
  name  = "${var.name}-initialize-secrets"
  role  = aws_iam_role.bootstrap[0].id
  policy = var.release.bootstrap_enabled ? jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadDedicatedMasterAndExistingCredentials"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = [var.database.master_secret_arn, var.database.runtime_secret_arn, var.database.migration_secret_arn]
      },
      {
        Sid      = "InitializeOnlyApplicationSecrets"
        Effect   = "Allow"
        Action   = "secretsmanager:PutSecretValue"
        Resource = [var.database.runtime_secret_arn, var.database.migration_secret_arn]
      },
    ]
    }) : jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Deny"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
      Resource = [var.database.master_secret_arn, var.database.runtime_secret_arn, var.database.migration_secret_arn]
    }]
  })
}

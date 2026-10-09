# IAM reading guide:
# - Role: the AWS identity a workload uses with temporary credentials.
# - Trust policy (assume_role_policy): who can assume that identity?
# - Permissions policy (aws_iam_role_policy): what actions on which resources?
# - Permissions boundary: caps identity-policy grants; it does not grant access.
# These are task identities, not the separate GitHub Actions deployment role.
locals {
  # Shared trust for active task roles. ECS can use them for tasks in our account;
  # this does not itself grant S3, Secrets Manager or other AWS API permissions.
  # jsonencode turns the Terraform object into AWS policy JSON.
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

# EXECUTION: ECS uses this to pull the container image and deliver container logs.
# The application does not use these permissions for its own AWS API requests.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = local.task_trust
  tags               = var.tags
  # Read the boundary ARN from the input map; null means no supplied boundary.
  permissions_boundary = lookup(var.task_permissions_boundaries, "execution", null)
}

# Inline policy: belongs directly to this role, unlike a standalone managed policy.
# Statement fields: Sid = label, Effect = Allow/Deny, Action = AWS API operation,
# Resource = permitted ARN(s), Condition = additional restrictions.
# Version is the IAM policy-language version, not this project's release date.
resource "aws_iam_role_policy" "execution" {
  name = "${var.name}-image-and-logs"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RegionalECRAuthentication"
        Effect = "Allow"
        Action = "ecr:GetAuthorizationToken"
        # This API does not support repository-scoped Resource ARNs.
        # Image-pull permissions in the next statement are repository-scoped.
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

# RUNTIME (task role): the application's AWS identity, supplied by ECS to the SDK.
# No permanent AWS access keys need to be embedded in the image or source code.
resource "aws_iam_role" "runtime" {
  name                 = "${var.name}-runtime"
  assume_role_policy   = local.task_trust
  tags                 = var.tags
  permissions_boundary = lookup(var.task_permissions_boundaries, "runtime", null)
}

# Least privilege: read only the runtime DB secret and work on specific S3 paths.
# Reading DB credentials is an IAM action; using them for SQL is controlled by
# PostgreSQL grants. Security groups control network reachability separately.
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
        Sid    = "StageAndVerifyUploads"
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"]
        # Staged uploads, before the application promotes an accepted image.
        Resource = "${var.image_bucket_arn}/pending/*"
      },
      {
        Sid    = "PromoteDownloadAndDeletePinnedVersions"
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:GetObjectVersion", "s3:DeleteObjectVersion"]
        # Final images are pinned to versions; no blanket access to every bucket.
        Resource = "${var.image_bucket_arn}/images/*"
      },
    ]
  })
}

# MIGRATION: separate identity for schema-change jobs, not the normal web service.
resource "aws_iam_role" "migration" {
  name                 = "${var.name}-migration"
  assume_role_policy   = local.task_trust
  tags                 = var.tags
  permissions_boundary = lookup(var.task_permissions_boundaries, "migration", null)
}

# Retrieve schema-owner credentials only. This does not itself execute migrations;
# SQL permissions come from that database user, not from this IAM policy.
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

# BOOTSTRAP: database credential initialization, unrelated to terraform/bootstrap/.
# Retained for existing state/history, but disabled in the current DEV release.
# || means OR: retain the role when either flag is true. Retention is not activation.
resource "aws_iam_role" "bootstrap" {
  count = var.release.bootstrap_enabled || var.release.bootstrap_retained ? 1 : 0
  name  = "${var.name}-bootstrap"
  # If initialization is disabled, deny ECS permission to assume this role.
  assume_role_policy = var.release.bootstrap_enabled ? local.task_trust : jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Deny", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags                 = var.tags
  permissions_boundary = lookup(var.task_permissions_boundaries, "bootstrap", null)
}

# Active initialization can read dedicated credentials and write application
# secrets. The disabled branch explicitly denies those operations instead.
# Explicit Deny overrides Allow; do not reactivate this role for routine releases.
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

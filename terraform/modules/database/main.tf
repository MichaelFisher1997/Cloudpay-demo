terraform {
  required_version = ">= 1.16.0, < 1.17.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.67.0, < 7.0.0" }
  }
}

# Inputs from the environment's composition module.
variable "name" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_id" { type = string }
variable "production" { type = bool }
variable "tags" { type = map(string) }
variable "final_snapshot_suffix" {
  type        = string
  description = "Set a unique, reviewed suffix before any approved retirement; never silently skip the final snapshot."
  default     = "review-required"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,59}[a-z0-9]$", var.final_snapshot_suffix))
    error_message = "Snapshot suffix must contain 2-61 lowercase alphanumeric/hyphen characters with alphanumeric ends."
  }
}

# Private placement, PostgreSQL settings and logs.
resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-database"
  subnet_ids = var.subnet_ids
  tags       = merge(var.tags, { Name = "${var.name}-database" })
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-postgres17"
  family = "postgres17"
  tags   = var.tags
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
  # Prevent SQL error logging from exposing credentials in bootstrap role DDL.
  parameter {
    name  = "log_statement"
    value = "none"
  }
  parameter {
    name  = "log_min_error_statement"
    value = "panic"
  }
}

resource "aws_cloudwatch_log_group" "postgresql" {
  name              = "/aws/rds/instance/${var.name}-postgres/postgresql"
  retention_in_days = var.production ? 30 : 7
  tags              = var.tags
}

# RDS instance: Single-AZ in DEV, Multi-AZ in the production template.
resource "aws_db_instance" "this" {
  identifier                          = "${var.name}-postgres"
  engine                              = "postgres"
  engine_version                      = "17.9"
  instance_class                      = var.production ? "db.t4g.small" : "db.t4g.micro"
  allocated_storage                   = var.production ? 50 : 20
  max_allocated_storage               = var.production ? 200 : 50
  storage_type                        = "gp3"
  storage_encrypted                   = true
  db_name                             = "godiffy"
  username                            = "godiffy_master"
  manage_master_user_password         = true
  multi_az                            = var.production
  publicly_accessible                 = false
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [var.security_group_id]
  parameter_group_name                = aws_db_parameter_group.this.name
  backup_retention_period             = var.production ? 14 : 7
  backup_window                       = "02:00-03:00"
  maintenance_window                  = "sun:03:30-sun:04:30"
  copy_tags_to_snapshot               = true
  deletion_protection                 = true
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${var.name}-final-${var.final_snapshot_suffix}"
  delete_automated_backups            = false
  allow_major_version_upgrade         = false
  auto_minor_version_upgrade          = false
  apply_immediately                   = false
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  iam_database_authentication_enabled = false
  tags                                = var.tags
  # Pin patch versions; review security releases regularly rather than drift backwards.
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [aws_cloudwatch_log_group.postgresql]
}

# Secret containers only: initialization wrote values outside Terraform.
# Routine deployment does not run initialization or database migrations.
resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${var.name}-runtime"
  description             = "Godiffy restricted DB credentials and authentication signing secret"
  recovery_window_in_days = var.production ? 30 : 7
  tags                    = var.tags
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret" "migration" {
  name                    = "${var.name}-migration"
  description             = "Godiffy schema-owner credentials for controlled migration jobs"
  recovery_window_in_days = var.production ? 30 : 7
  tags                    = var.tags
  lifecycle {
    prevent_destroy = true
  }
}

# Identifiers passed to the application module; no secret values.
output "host" { value = aws_db_instance.this.address }
output "identifier" { value = aws_db_instance.this.identifier }
output "runtime_secret_arn" { value = aws_secretsmanager_secret.runtime.arn }
output "migration_secret_arn" { value = aws_secretsmanager_secret.migration.arn }
output "master_secret_arn" { value = one(aws_db_instance.this.master_user_secret).secret_arn }

output "host" { value = aws_db_instance.this.address }
output "identifier" { value = aws_db_instance.this.identifier }
output "runtime_secret_arn" { value = aws_secretsmanager_secret.runtime.arn }
output "migration_secret_arn" { value = aws_secretsmanager_secret.migration.arn }
output "master_secret_arn" { value = one(aws_db_instance.this.master_user_secret).secret_arn }

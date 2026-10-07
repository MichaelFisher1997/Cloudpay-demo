mock_provider "aws" {
  mock_resource "aws_db_instance" {
    defaults = {
      master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:eu-west-2:218549829565:secret:rds!db-test", secret_status = "active", kms_key_id = "test" }]
    }
  }
}
variables {
  name              = "godiffy-dev"
  production        = false
  subnet_ids        = ["subnet-11111111", "subnet-22222222"]
  security_group_id = "sg-11111111"
  tags              = { Project = "godiffy", Environment = "dev", ManagedBy = "terraform", Purpose = "cloudpay-technical-assessment" }
}

run "dev_database_safety" {
  command = plan
  assert {
    condition = (
      !aws_db_instance.this.publicly_accessible && aws_db_instance.this.storage_encrypted &&
      aws_db_instance.this.deletion_protection && !aws_db_instance.this.skip_final_snapshot &&
      aws_db_instance.this.manage_master_user_password && aws_db_instance.this.password == null &&
      aws_db_instance.this.backup_retention_period == 7 && !aws_db_instance.this.multi_az &&
      aws_db_instance.this.instance_class == "db.t4g.micro"
    )
    error_message = "Dev must retain private/encrypted/snapshot-protected RDS with AWS-managed master credentials."
  }
}

run "prod_database_resilience" {
  command = plan
  variables {
    name       = "godiffy-prod"
    production = true
  }
  assert {
    condition = (
      aws_db_instance.this.multi_az && aws_db_instance.this.instance_class == "db.t4g.small" &&
      aws_db_instance.this.backup_retention_period == 14 && aws_db_instance.this.deletion_protection &&
      !aws_db_instance.this.skip_final_snapshot && aws_db_instance.this.allocated_storage == 50 &&
      aws_secretsmanager_secret.runtime.recovery_window_in_days == 30
    )
    error_message = "Prod must retain Multi-AZ, backup, secret recovery and deletion protections."
  }
}

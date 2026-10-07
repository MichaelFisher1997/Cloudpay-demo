terraform {
  required_version = "~> 1.16.0"
  backend "s3" {}
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.67.0" }
  }
}

provider "aws" {
  region              = "eu-west-2"
  allowed_account_ids = ["218549829565"]
}

module "godiffy" {
  source                 = "../../modules/godiffy"
  environment            = "dev"
  release                = var.release
  app_url                = var.app_url
  certificate_arn        = var.certificate_arn
  alarm_email            = var.alarm_email
  https_redirect_enabled = var.https_redirect_enabled
  invited_emails         = var.invited_emails
  final_snapshot_suffix  = var.final_snapshot_suffix
}

output "deployment" {
  description = "Dedicated Godiffy development integration details, not credentials."
  value       = module.godiffy.deployment
}

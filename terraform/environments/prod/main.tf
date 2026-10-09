# Undeployed module-reuse example, not a production delivery configuration.
# An apply could still create foundations; no production apply is authorised.
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
  source      = "../../modules/godiffy"
  environment = "prod"
  # Module defaults leave the service and database jobs disabled.
}

output "deployment" {
  description = "Example production foundation identifiers; this environment is not deployed."
  value       = module.godiffy.deployment
}

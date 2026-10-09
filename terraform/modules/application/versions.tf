# Compatibility requirements for this child module. The environment root pins
# the provider more narrowly; .terraform.lock.hcl records the selected version.
terraform {
  required_version = ">= 1.16.0, < 1.17.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.67.0, < 7.0.0" }
  }
}

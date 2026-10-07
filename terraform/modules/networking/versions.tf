terraform {
  required_version = ">= 1.16.0, < 1.17.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.67.0, < 7.0.0" }
  }
}

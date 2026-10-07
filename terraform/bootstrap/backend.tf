# The dedicated bucket was bootstrapped locally, then state was migrated to S3.
# Backend configuration contains identifiers only; credentials come from SSO/OIDC.
terraform {
  backend "s3" {}
}

# Human SSO first bootstraps these exact policies to enable OIDC. Actions imports
# them into DEV state; it can read, never edit, its own scope or task boundaries.
locals {
  ci_policy_files = {
    for file in fileset("${path.module}/../../../aws/ci/policies", "*.json") :
    trimsuffix(file, ".json") => file
  }
  ci_tags = {
    Project = "godiffy", Environment = "dev", ManagedBy = "terraform", Purpose = "cloudpay-technical-assessment"
  }
}
resource "aws_iam_policy" "ci_scopes" {
  for_each = local.ci_policy_files
  name     = "godiffy-dev-${each.key}"
  policy   = file("${path.module}/../../../aws/ci/policies/${each.value}")
  tags     = local.ci_tags
  lifecycle { prevent_destroy = true }
}
import {
  for_each = local.ci_policy_files
  to       = aws_iam_policy.ci_scopes[each.key]
  id       = "arn:aws:iam::218549829565:policy/godiffy-dev-${each.key}"
}
resource "aws_iam_role_policy_attachment" "dev_ci" {
  for_each   = { for key, file in local.ci_policy_files : key => file if startswith(key, "ci-") }
  role       = "cloudpay-demo-github-actions"
  policy_arn = aws_iam_policy.ci_scopes[each.key].arn
}
import {
  for_each = { for key, file in local.ci_policy_files : key => file if startswith(key, "ci-") }
  to       = aws_iam_role_policy_attachment.dev_ci[each.key]
  id       = "cloudpay-demo-github-actions/arn:aws:iam::218549829565:policy/godiffy-dev-${each.key}"
}
resource "aws_secretsmanager_secret" "smoke" {
  name                    = "godiffy-dev-smoke-fixtures"
  description             = "Disposable DEV HTTP smoke credentials; never Terraform secret values"
  recovery_window_in_days = 7
  tags                    = local.ci_tags
  lifecycle { prevent_destroy = true }
}
output "smoke_secret_arn" { value = aws_secretsmanager_secret.smoke.arn }

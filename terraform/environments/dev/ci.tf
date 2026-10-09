# Human SSO first bootstraps these exact policies to enable OIDC. Actions imports
# them into DEV state; it can read, never edit, its own scope or task boundaries.
# This is AWS IAM configuration, not a GitHub Actions workflow. Terraform reads
# it together with main.tf. The existing Actions role and OIDC trust are managed
# separately; this file tracks policies, their attachments and a legacy secret.
locals {
  # Find the policy JSON files and build a map such as:
  # "ci-network" => "ci-network.json".
  # path.module means this DEV root; trimsuffix removes the .json extension.
  # These map keys become resource addresses, so do not rename files casually.
  ci_policy_files = {
    for file in fileset("${path.module}/../../../aws/ci/policies", "*.json") :
    trimsuffix(file, ".json") => file
  }
  ci_tags = {
    Project = "godiffy", Environment = "dev", ManagedBy = "terraform", Purpose = "cloudpay-technical-assessment"
  }
}
# Create/track one IAM policy for each JSON file:
# - ci-* policies grant scoped permissions to the GitHub Actions role.
# - boundary-* policies cap task-role permissions; boundaries do not grant access.
# main.tf passes the boundary ARNs to the application module's task roles.
resource "aws_iam_policy" "ci_scopes" {
  for_each = local.ci_policy_files
  name     = "godiffy-dev-${each.key}"
  policy   = file("${path.module}/../../../aws/ci/policies/${each.value}")
  tags     = local.ci_tags
  # Guard against accidental policy deletion while this block remains configured.
  lifecycle { prevent_destroy = true }
}
# Adopt the already-created policies into Terraform instead of creating duplicates.
# Imports do not recreate policies and are skipped when already tracked in state.
import {
  for_each = local.ci_policy_files
  to       = aws_iam_policy.ci_scopes[each.key]
  id       = "arn:aws:iam::218549829565:policy/godiffy-dev-${each.key}"
}
# Attach only the ci-* policies to the existing deployment role.
# The "for ... if" expression filters out the task permission-boundary policies.
resource "aws_iam_role_policy_attachment" "dev_ci" {
  for_each   = { for key, file in local.ci_policy_files : key => file if startswith(key, "ci-") }
  role       = "cloudpay-demo-github-actions"
  policy_arn = aws_iam_policy.ci_scopes[each.key].arn
}
# Adopt those existing role-to-policy attachments too.
# The import ID combines the role name and policy ARN with a slash.
import {
  for_each = { for key, file in local.ci_policy_files : key => file if startswith(key, "ci-") }
  to       = aws_iam_role_policy_attachment.dev_ci[each.key]
  id       = "cloudpay-demo-github-actions/arn:aws:iam::218549829565:policy/godiffy-dev-${each.key}"
}
# Historical password-auth smoke-test secret: current workflows no longer use it.
# Keep the tracked container until retirement is separately reviewed; removing
# the resource declaration could propose deleting the AWS secret.
# Terraform manages metadata only here, not passwords or other secret values.
resource "aws_secretsmanager_secret" "smoke" {
  name                    = "godiffy-dev-smoke-fixtures"
  description             = "Disposable DEV HTTP smoke credentials; never Terraform secret values"
  recovery_window_in_days = 7
  tags                    = local.ci_tags
  lifecycle { prevent_destroy = true }
}
# This output is the secret's identifier, not its contents.
output "smoke_secret_arn" { value = aws_secretsmanager_secret.smoke.arn }

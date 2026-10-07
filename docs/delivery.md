# Delivery and approval boundaries

## Implemented: validation only

`.github/workflows/validate.yml` runs on pull requests, master pushes and manual
dispatch. It checks Terraform formatting/validation and mock tests, application
format/types/tests/build, isolated local PostgreSQL integration, dependency
advisories and the amd64 Docker build/read-only non-root smoke. Actions and tool
versions are pinned. Built-server HTTP tests exercise the actual output against
local PostgreSQL, with explicit local-only connection overrides.

It has only `contents: read`, does not persist checkout credentials, requests no
OIDC token, uses no AWS credentials/backend, and does not push images or apply
infrastructure. Fork PR code must never run with deployment credentials.
The existing authentication-only OIDC check is preserved byte-for-byte.
Local actionlint/ShellCheck pass; the new workflow has not been pushed or run in
GitHub, so a GitHub CI success is not yet claimed.

## Proposed privilege boundaries — not provisioned

Reuse the existing GitHub OIDC **provider**. The existing
`cloudpay-demo-github-actions` role trusts the immutable repository identity and
`master`, and currently has no permissions. Do not recreate the provider or add
AdministratorAccess. Decide whether to use that role for scoped dev delivery or
keep its identity-only demonstration purpose; avoid unexplained duplicate roles.

| Work | Authentication and authority |
| --- | --- |
| PR validation | No AWS access, including no state reads |
| Reviewed planning | Human SSO initially; a later trusted plan role may read exact environment state/resources and write/delete only its lock object |
| Dev apply/release | A reviewed dev-only role, separate from production permissions; exact dev backend, repository and role/resource boundaries |
| Production apply/release | Separate role trusted only by a protected production GitHub Environment subject, not by unrestricted master jobs |
| Master DB initialization | Explicit controlled operator job, not routine runtime/CI secret access |

**Current master trust does not match PR or GitHub Environment subjects.** Adding
an `environment:` job will not magically authenticate with it. Discover and
review the actual immutable environment subject before adding exact production
trust. Never grant production permissions to the branch-accessible dev role and
rely solely on a workflow's approval job: another master workflow could bypass it.

Configure required reviewers, prevent self-approval, protect master, and restrict
production environment branches before granting production authority. Confirm the
repository/account plan supports the required protections and a second approver
is actually available. Until then, production is operator-reviewed only and
cannot be claimed to have a functioning protected CI deployment path.

## Permission design requirements

- Backend `ListBucket` limited to required Godiffy prefix; exact state Get/Put;
  `.tflock` Get/Put/Delete. No routine state-object deletion, bootstrap bucket
  destruction, or production state read for dev roles.
- Repository-specific ECR image operations; only ECR authentication has justified
  `Resource=*` and a region condition.
- `iam:PassRole` only reviewed Godiffy environment task/execution/migration roles,
  constrained to ECS tasks. No passing the RDS master/bootstrap role during routine
  release and no role/policy mutation outside the dedicated reviewed boundary.
- Use required request/resource tags and exact ARNs where AWS supports them.
  Some EC2/other discovery APIs require `Resource=*`; document the minimum explicit
  actions and limitations instead of claiming impossible per-resource Describe scope.
- Plan/apply identities do not need `secretsmanager:GetSecretValue` for application
  values. Terraform manages secret metadata, not credentials. State itself may still
  contain sensitive data; restrict its reads and artifact visibility.
- Role creation permissions can escalate authority through newly created roles:
  evaluate a permissions boundary and tag/PassRole controls before authorizing CI
  to manage IAM. A prefix by itself is not a complete escalation defense.

No such CI policies, roles, trust changes or environment settings were applied.
Human SSO remains deliberately privileged; isolate and review commands, never
treat its profile name as permission to manage other applications.

## Proposed release sequence

1. Validate code, dependency/image scans and local integration; build **one**
   linux/amd64 image tagged with a unique commit/release identifier.
2. After ECR foundations approval, push to the dedicated environment repository,
   inspect scan findings, and record its immutable manifest digest. Keep rollback
   tags: the repository lifecycle expires only untagged artifacts.
3. Generate a saved plan from the exact code/release digest. Review scope, unknowns,
   changes/deletions, cost and migration impact. Store the plan with restricted
   access, short retention and a recorded hash; never public raw state/plan JSON.
4. Explicitly approve and apply that exact saved plan under one environment-level
   concurrency group; S3 lockfile additionally protects Terraform writers.
5. Run/check approved one-off migrations **before** service activation, then
   Terraform-owned task/service update. Circuit breaker can roll back unhealthy
   deployment, but database changes need an independently reviewed rollback strategy.
6. Verify users/ownership/direct S3 flow, logs/alarms and task AZ distribution.
   Promote the same tested artifact to prod only after its separate approval.

Do not let an independent `aws ecs update-service` pipeline and Terraform both
own task definitions. Do not use `ignore_changes` on the task definition to hide
drift. State locking is not application-migration locking: PostgreSQL advisory
locks serialize the database jobs separately. Initial RDS applies can exceed a
short OIDC session; review credential/session duration without adding permanent keys.

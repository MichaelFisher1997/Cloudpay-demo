# Delivery and approval boundaries

## Implemented: credential-free validation

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
Local actionlint/ShellCheck pass. The new workflow was committed/pushed in
`7809dabb87812ae9da125003a5d7d8df826c9bc9`; GitHub
[run 37607324492](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37607324492)
passed Terraform/app tests, actual built-server/local PostgreSQL integration,
dependency audit, Docker build and read-only/non-root smoke. This verifies the
credential-free validation path, **not AWS deployment**. The actions emitted a
Node 20 deprecation annotation while running under GitHub's forced Node 24 runtime;
the workflow succeeded. Review action/runner pins as part of maintenance.

## Authorized DEV Actions delivery

The existing GitHub OIDC **provider** is deliberately reused. The existing
`cloudpay-demo-github-actions` role trusts the immutable repository identity and
`master`. The user authorized narrowly scoped DEV permissions on this role and
requires **all application deployments from Actions**, not the local SSO session.
The trust policy/provider/profile are unchanged; no AdministratorAccess, IAM user
or permanent key has been added.

`scripts/ci-policies.py` generates nine reviewable policies under `aws/ci/policies/`:
five DEV CI scopes and four separate task boundaries. IAM Access Analyzer returned
no findings for all nine. `scripts/bootstrap-ci.py` human-bootstrapped these exact
policies; Actions imports their metadata/attachments into DEV state but has no
permission to edit those policies, attach arbitrary policies or change boundaries.
Role creation requires the exact role-specific boundary and four ownership tags.
Runtime/migration/execution boundaries never permit master-secret access. The
bootstrap boundary initially excludes the unknown master ARN; human bootstrap
must bind only the actual dedicated DB's secret ARN after foundations.

The user separately approved creation of exactly the missing AWS-managed
`AWSServiceRoleForRDS` and `AWSServiceRoleForApplicationAutoScaling_ECSService`.
CI can create only these two service roles, not edit/delete existing service roles.
All other application writes are dedicated DEV names/ARNs or tag-guarded resources;
regional discovery uses explicit read actions. Initial scalable-target creation
requires DEV ownership tags and is tightened to its exact generated ARN afterward.
RDS-managed master-secret creation/tagging is initially restricted to RDS forward
  access; Actions created the managed master secret successfully in the foundation rollout.

### Manual delivery workflows

- `dev-deploy.yml`: `foundations`, `jobs`, `service`; `plan` defaults to read-only
  resource planning (with lock acquisition). Apply requires a reviewed semantic
  plan fingerprint. A fresh saved plan is audited and applied in the same runner;
  a changed fingerprint, deletion/replacement, production/unrelated resource,
  domain/ACM input, expensive shape or self-IAM update stops execution.
- `dev-image.yml`: amd64 build/read-only smoke and immutable commit-tagged push to
  the exact DEV ECR repository. It reports the manifest digest, not credentials.
  Publication and jobs/service deployment require the exact digest's completed ECR
  OS scan with zero critical/high findings. App dependency advisories are checked
  separately; neither scan is a blanket security certification.
- Private bootstrap/migration/DB-verification jobs run via Actions with no public
  task IP. Service activation re-verifies the DB before apply, then exercises real
  HTTP auth/ownership and direct S3 POST/CORS/checksum/size/download/deletion.
- All deployment workflows share one non-cancelling DEV concurrency group. Only
  master can assume the role. No environment trust, production authority or PR
  credentials are introduced. Raw plans/state are never uploaded as artifacts.
- HTTP test passwords are generated inside the runner and saved only in a
  dedicated disposable fixture secret. CI cannot read application, migration or
  RDS master secrets; controlled bootstrap indirect authority is removed afterward.
- Human retirement additionally sets the bootstrap boundary to explicit secret
  denials and removes CI bootstrap `PassRole`. CI cannot restore master access by
  editing the retained role's trust or inline policy. This is independent of the
  Terraform in-place trust/policy denials.

Terraform remains the task-definition/service owner. Actions retains prior image
digests from state and creates new digest-keyed definitions without deleting old
revisions. Changes to existing immutable definitions still fail closed under the
no-deletion guard; `skip_destroy` is not used to bypass that guard.

| Work | Authentication and authority |
| --- | --- |
| PR validation | No AWS access, including no state reads |
| Reviewed planning | DEV Actions role reads exact DEV state/resources and writes/deletes only its lock during plan |
| Dev apply/release | Reused, DEV-scoped OIDC role; exact DEV backend, repository, task boundaries and fail-closed reviewed-plan guard |
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

Nine dedicated DEV policies and five attachments were bootstrapped. Application
resources are not yet deployed at this documentation checkpoint. No trust/provider
or environment-setting change was made. Human SSO remains deliberately privileged; isolate and review commands, never
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

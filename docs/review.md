# Historical review handoff — build-and-plan stage

> This preserves the earlier build-and-plan evidence, not the current inventory.
> DEV was subsequently deployed through GitHub Actions after SSO renewal. See
> [the current deployment handoff](dev-deployment.md) for URL/digests, actual AWS
> results, costs and [separately approved retirement](teardown.md). The historical
> plans below are not safe retry inputs; production remains unauthorized.

## What was live at that stage

The approved dedicated bucket `godiffy-terraform-state-218549829565-eu-west-2`
and five configuration resources in account `218549829565`, London. Apply:
**6 added, 0 changed, 0 destroyed**. Remote bootstrap state contains those six
records, the refreshed plan is empty, and encryption/versioning/lock release
were verified. Migration recovery and local backups are documented in
[terraform-state.md](terraform-state.md).

No dev/prod application infrastructure was applied. Existing SSO/profile and
OIDC role permissions remain unchanged. No DNS/certificate request, ECR push,
AWS DB job execution or new CI permission grant was performed during that stage.

## Reviewable artifacts

| Artifact | Result |
| --- | --- |
| `app/` | Strict TypeScript TanStack/Bun gallery, private signed-image flow, DB auth/sessions/rate limit, separate bootstrap/migration jobs |
| `terraform/modules/` | Cohesive network/storage/database/application modules with environment composition and alarms |
| `terraform/environments/dev/` | Single-task/Single-AZ dev draft; default foundations only |
| `terraform/environments/prod/` | Two-AZ production draft, safety guards; default foundations only |
| `.github/workflows/validate.yml` | No-AWS validation/image build, pinned actions; subsequently pushed and verified by GitHub run 37607324492 |
| `scripts/` | Repeatable validation, isolated PG integration and create-only foundation scope audit |
| `docs/` | Architecture/diagram, six pillars, cost worksheet, operations and delivery approval design |

The build work was committed/pushed as `7809dab` under the subsequent DEV authorization.
Generated dependencies/builds, state,
local tfvars and binary/text plan artifacts are ignored, not public evidence dumps.

## Saved real AWS-provider plans — not approval

| Environment | Local ignored plan | Add/change/delete |
| --- | --- | --- |
| Dev | `terraform/environments/dev/dev-foundations.tfplan` | **72 / 0 / 0** |
| Prod | `terraform/environments/prod/prod-foundations.tfplan` | **76 / 0 / 0** |

SHA-256 identities at handoff:

```text
dev  e1c7bc3f697065018ac0f9e2ab962496558a67ef2a893d1b4161d1b821e935ce
prod ac33b2570717c9c92404d79fe584242febf4a9f2aa0f9f9ab606e5b9b75379ea
```

Plans use the real provider, fixed account/region and separate S3 backends, not
mock-generated resource plans. Creation/uniqueness, service limits and runtime
behavior are not guaranteed by a plan. Re-plan for code/account drift or expired
credentials before asking approval; update/review the hash if the plan changes.

Each includes one dedicated VPC, six subnets, four SGs, routes/associations,
four interface endpoints plus S3 gateway, private RDS/parameter/subnet group,
two empty secret containers, private images/CORS/lifecycle settings, ECR, ECS
cluster, ALB/target group, three task-side IAM roles/policies, log groups,
SNS topic/policy and six alarms. Dev has one initial HTTP listener; prod instead
has a dedicated ALB log bucket and protections and **no plaintext listener**.

Neither includes ECS service/task definitions, automatically executed DB jobs,
master-access bootstrap roles, customer KMS keys, NAT, ACM/DNS, or CI deployment
roles/policies. RDS-generated master secret creation is managed by RDS and is not
a Terraform secret-value resource. Tagged ECR release images are retained.

## Verification evidence and its limits at that stage

- Terraform formatting and all eight root/module configurations validated;
  **24 mocked Terraform test runs** pass, including negative namespace/AZ/image,
  production approval/TLS, migration and invitation guards.
- **6 Python scope-audit fixture tests**; both saved foundation plans passed audit.
- App formatting, strict typecheck, production build and frozen dependency install.
  **13 unit tests** plus isolated **PostgreSQL 17 integration** with real SQL/auth
  and mocked AWS; restricted non-superuser creator behavior is covered locally.
- Built-server HTTP integration uses the actual `.output` artifact against local
  PostgreSQL: **1 test / 49 assertions**, including signup/login/session/gallery
  and cross-origin/non-invite rejection. Local-only connection overrides do not
  establish production RDS TLS or real ALB behavior.
- Dependency audit reports **0 current advisories**; this is not an OS/container
  vulnerability scan or a permanent security guarantee. Nitro currently uses a
  pinned beta to avoid known vulnerable older packages; approve that framework
  choice and review upgrade cadence before production.
- Built linux/amd64 image smoke tests verify UI/process probes with non-root,
  read-only runtime and fail-closed production HTTP/insecure configuration.
- Actionlint and ShellCheck pass locally. Subsequent GitHub-hosted
  [validation run 37607324492](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37607324492)
  passed all tests/build/container checks without AWS credentials.

Remaining library warnings are recorded in `app/README.md`: Nitro beta/Rolldown
module-directive diagnostics and Better Auth's generated bigint rate-limit schema
type warning. Functional tests pass; these are not silently treated as production
certification. Validation now isolates Terraform metadata/credentials so an
operator's previously initialized S3 backend cannot make offline mock tests
unexpectedly depend on SSO.

**Not verified in AWS:** Fargate endpoint image pulls, managed RDS-master role
behavior, real Secrets Manager job writes, S3 browser POST/checksum/CORS, IAM
authorization, ALB service health/log delivery, SNS subscription confirmation,
prod AZ failover, restoration or load/cost measurements. No website URL is live.

## Decisions recorded at that stage

1. Endpoint-only design and one-AZ dev compromise; sizing, budget/alert recipient
   and continuous foundation costs ([costs](costs.md)).
2. TanStack/Bun/Better Auth shape and pinned Nitro beta; verified production
   invitations. Email allowlisting is dev-only and not inbox verification.
3. ALB→task private HTTP exception versus backend TLS; encryption-key/compliance
   requirements and image content threat limits.
4. Retention, proposed RPO/RTO, manual runtime credential rotation, restore drills
   and regional/account disaster-recovery requirements.
5. Terraform-owned release flow, exact CI policies/permissions boundary, existing
   role purpose, protected production subject and available approver.
6. Whether to review/deploy foundations as a bundle or smaller staged code changes.
   Production and domain/TLS integration always remain separately approved stages.

## Original review boundary (superseded for DEV)

DEV infrastructure, immutable ECR publication, jobs, ECS activation, real AWS tests
and narrowly scoped DEV CI permissions are now authorized. Re-plan and enforce
the user's stop-on-deletion/unrelated-resource rules before each apply. Restrict
temporary bootstrap privileges without deleting resources under this authorization.
Production, ACM and domain/DNS work remain forbidden. AWS authentication must be
restored before proceeding at that historical checkpoint. That renewal and DEV
deployment have since occurred; use the current deployment record, not this old
"not verified in AWS" list, for present-day claims.

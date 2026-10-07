# DEV deployment status — 7 October 2026

## Outcome: authorized, GitHub Actions rollout in preparation

The user approved autonomous **DEV-only** deployment in account `218549829565`,
region `eu-west-2`, using the existing `portyard` SSO profile and
`PortyardAdministrator` human role. Production, Cloudflare/Route 53, ACM, custom
domains, permanent keys and broad CI permissions remain forbidden.

The earlier AWS identity preflight could not authenticate. The cached SSO access token
expired at **2026-10-07 00:34:12 UTC**; refresh returned HTTP 400
`invalid_grant` at approximately **10:19 UTC**. A desktop browser is not connected,
so this session cannot complete a normal interactive SSO login on the user's behalf.
The profile, role and AWS account configuration were not changed. The user has
since renewed the existing session; exact account/human SSO identity verification
now succeeds.

**Deployment must run from GitHub Actions**, per the user's latest direction.
Human SSO is used only for read-only checks and bootstrap of the exact DEV CI
permissions/task boundaries. No local Terraform application apply, ECR push,
database job or ECS rollout is permitted. The user separately approved creation
of exactly the missing AWS-managed RDS and ECS autoscaling service-linked roles
by Actions; existing ECS/ELB service-linked roles remain unchanged.

The delivery workflows enforce master-only OIDC, DEV state/account/region,
immutable digests, explicit plan-review fingerprints, no Terraform deletions or
replacements, and no CI edits to its own permissions or task boundaries. Bootstrap
retirement restricts its trust/policy in place while retaining the role and task
definition. Real private DB verification and HTTP/S3 smoke scripts are prepared;
they have not yet run against AWS.

No Terraform application apply, ECR push, AWS job or application resource mutation
has occurred yet in the resumed rollout. Nine exact DEV IAM policies and five
attachments have now been human-bootstrapped; no trust/profile change or alternate credentials were
introduced. GitHub repository access is independent of this AWS login.

The implementation and status/runbooks were committed and pushed to `master` in
`7809dabb87812ae9da125003a5d7d8df826c9bc9`. GitHub
[validation run 37607324492](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37607324492)
**passed**: 24 mocked Terraform runs, app formatting/types/13 unit tests,
local PostgreSQL and actual built-server HTTP integration, dependency advisory
check, amd64 Docker build, and read-only/non-root/production guard smoke. This
workflow has no AWS credentials or deployment authority. No deployment workflow
was run and no DEV OIDC IAM permissions could be configured without AWS access.

For future session renewal, preserve the existing profile:

```sh
nix-shell --run 'aws sso login --profile portyard'
nix-shell --run 'aws sts get-caller-identity --profile portyard --region eu-west-2'
```

Expected account: `218549829565`; expected human role: `PortyardAdministrator`.
Do not send tokens/passwords in chat, replace the profile or create access keys.

## Actual resources and verification

| Required handoff item | Actual status |
| --- | --- |
| Deployed resources | Previously approved dedicated state bucket and its five configuration resources only; no new DEV resources in this attempt |
| Plan/apply counts | Last saved DEV foundation plan: **72 add / 0 change / 0 delete**; no new authenticated plan or apply possible; this attempt applied **0 resources** |
| DEV ALB URL | Not created; no application URL is available |
| ECR tag/digest | Local amd64 image built/tested; no ECR repository/image publication yet |
| ECS service/tasks | Not created; no Fargate job or service execution |
| RDS | Not created; production RDS TLS path untested |
| S3 image tests | Only local mock/presigned-policy tests; real S3 POST/CORS/download/delete/private-access tests not performed |
| Bootstrap/migration | Local PG17 and actual built-server HTTP tests pass; no AWS job run |
| IAM task roles | Planned execution/runtime/migration roles; none created in DEV |
| GitHub OIDC | Existing provider/trust unchanged; five exact DEV CI scopes and four immutable task boundaries human-bootstrapped |
| GitHub validation | Run 37607324492 succeeded for commit 7809dab; no AWS deployment step |
| Real AWS tests in this attempt | Authentication/connectivity preflight only; resource verification is blocked |
| Earlier blocker | SSO expiry resolved by the user; intermittent AWS API read timeouts were handled by bounded, idempotent bootstrap retries |
| Still unverified | Entire deployed DEV path, private ECR pull, RDS master privileges/TLS, real S3 semantics, ALB health, logs/metrics, alarms, task replacement and OIDC deployment |
| DEV recurring cost | No new DEV resource cost incurred; proposed always-on small-dev envelope **$100–170/month**, subject to usage; prior state-only footprint normally under $1/month |
| Compromises | Planned one task/endpoint AZ and Single-AZ DB, HTTP/disposable test accounts, email-string allowlist, pinned Nitro beta, no regional DR |
| Production | Undeployed; separate roots/plans and HTTPS/redundancy safeguards remain intact |
| Domain/TLS work | Not performed; no ACM request or Cloudflare/Route 53 change |

Previous bootstrap verification is recorded in [terraform-state.md](terraform-state.md);
it was not repeated with expired credentials. Saved plans must be refreshed and
scope-reviewed before apply, not assumed current because they exist locally.

## Resume checklist

- [x] Renew SSO; verify exact account and role.
- [x] Amend bootstrap retirement to restriction without Terraform resource deletion.
- [x] Validate and bootstrap exact DEV-only OIDC permissions and task boundaries.
- [ ] Commit/push Actions-only delivery workflows and offline/real-test safeguards.
- [ ] Re-plan DEV; reject all deletions/unrelated resources; apply the reviewed saved plan.
- [ ] Verify network, private endpoints/SGs, versioned private images, RDS and ECR.
- [ ] Commit/build a linux/amd64 image; publish immutable SHA tag and record digest.
- [ ] Plan/apply narrowly scoped private bootstrap/migration definitions and roles.
- [ ] Run/check job exit codes; test RDS TLS and runtime SQL privileges.
- [ ] Restrict bootstrap access in place, without deleting Terraform resources.
- [ ] Plan/apply one-replica HTTP DEV service, monitoring and scaling.
- [ ] Test signup/login/session, DB, S3 POST/CORS/limits/download/delete and ownership.
- [ ] Test bucket privacy, IAM denial, metrics/logs and basic task replacement.
- [ ] Configure DEV-only OIDC delivery; execute validation and a safe actual release.
- [ ] Confirm a converged DEV plan; record exact deployed inventory and evidence.
- [ ] Update this document/architecture/interview notes; commit and push final results.

## Teardown after the interview

This approval **does not authorize a routine teardown**. Obtain explicit approval
for the exact Godiffy DEV resource/data inventory before any destroy. Never destroy
the bootstrap backend, production or unrelated resources.

At the current blocked stage, there are no newly created DEV resources from this
attempt to tear down. After deployment, use this sequence under fresh scoped approval:

1. Disable DEV delivery so it cannot recreate resources. Back up the exact DEV
   state securely and record image-version/database retention requirements.
2. Review only `terraform/environments/dev`, its exact backend key and Godiffy names.
   Stop on any non-DEV/unrelated resource in the proposed retirement plan.
3. Choose a unique final DB snapshot suffix; explicitly review removal of DEV
   `prevent_destroy`/deletion protection. Keep `skip_final_snapshot=false`.
4. Retire the service/jobs and dedicated DEV resources using the exact reviewed
   destroy plan, not broad AWS deletes or an unreviewed `terraform destroy`.
5. Nonempty ECR and versioned image buckets intentionally refuse forced deletion.
   Obtain separate exact-scope data-deletion approval before removing their images,
   object versions or delete markers. Never set `force_destroy=true` for convenience.
6. Verify the final snapshot and retained automated backups; document their ongoing
   cost. Keep approved backend and local backups. Verify DEV state/resource inventory
   is empty only when the deliberately retained data/resources are accounted for.

No destructive command has been run as part of this handoff.

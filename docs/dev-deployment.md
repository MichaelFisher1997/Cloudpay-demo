# DEV deployment status — 7 October 2026

## Outcome: private jobs passed; service running; guarded status-read retry next

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

Nine exact DEV IAM policies and five attachments were human-bootstrapped without
trust/profile changes or alternate credentials. Commit `b994283` enabled guarded
Actions-only delivery. Credential-free [validation run 37619760584](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37619760584)
passed. [Foundation plan 37619787401](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37619787401)
passed review: **73 additions, 14 exact CI imports, 0 changes, 0 deletions**.

[Apply 37620104649](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37620104649)
matched its reviewed fingerprint but stopped on log tag-read ARN spelling,
security-rule/endpoint attachment IAM checks and invalid wildcard SNS topic actions.
The partial DEV VPC/subnets/routes/security groups, private versioned image bucket,
three empty secret containers, DB parameter/subnet groups and alarm topic are retained.
No image, database job or web service has run yet. The retry adds only exact DEV
permissions and valid SNS topic actions. One failed-new empty DB log group is
tainted; an explicitly selected Actions repair verifies recent creation, ownership
and no streams/data before retaining it with `untaint`, not replacing/deleting it.

The next apply created the remaining network, RDS and ALB but stopped on an
unfiltered provider RDS metadata read. An exact account/region read-only permission
fixed that path. The failed-new DB was verified available, recent, correctly tagged,
with no application credentials, jobs or tasks, then retained by Actions `untaint`.
Both repairs kept the physical resources; neither deleted data or infrastructure.

[Foundation apply 37630947179](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37630947179)
completed its last **8 additions, 0 changes, 0 deletions** and confirmed **no changes**
on a refreshed plan. The complete foundation is **73 new DEV records plus 14 exact
CI imports**. [Image publication 37628283144](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37628283144)
built/smoke-tested amd64 and pushed immutable tag `1c0b0f698fb4b1e31d5ee99916a3b894f7f24f07`,
digest `sha256:44c6c7efdd7feb4b688bea19c1c158f6efcea49accb213b31c5426e0bd44dfa3`.
The jobs [plan 37631037555](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37631037555)
passed scope review: **6 additions, 0 changes, 0 deletions**.
[Jobs apply 37633228998](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37633228998)
created those six records, ran bootstrap/migration/runtime verification privately
with **exit 0** for each and confirmed a zero-change plan. Verification exercised
validated TLS, rejected plaintext and restricted SQL/master/migration-secret access.
Human retirement set the bootstrap boundary to explicit secret denials and removed
CI bootstrap `PassRole`; Actions also denied the retained role's trust/inline policy.

[Service apply 37636634654](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37636634654)
created the service but its provider health waiter lacked `ecs:ListServiceDeployments`.
AWS reports **one running task, completed rollout, no failed tasks**, while Terraform
marked the service tainted. The user separately approved a guarded Actions-only
retention repair after verifying exact tags, recent creation, image, private network
and healthy ALB target. Only failed-read state taint is cleared; deletion/replacement
remains forbidden. The narrowly scoped deployment metadata reads are being added.

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

## Actual resources and verification (superseded as rollout progresses)

| Required handoff item | Actual status |
| --- | --- |
| Deployed resources | Six approved backend records; **87 DEV state records** = 73 new foundations plus 14 exact CI policy/attachment imports |
| Plan/apply counts | Foundations completed across focused retries, **0 deletions**; final refreshed plan **0 add / 0 change / 0 delete**; jobs plan **6 / 0 / 0** |
| DEV ALB URL | `http://godiffy-dev-alb-1345285825.eu-west-2.elb.amazonaws.com`; listener exists but no service target yet, not a working website |
| ECR tag/digest | Immutable commit `1c0b0f698fb4b1e31d5ee99916a3b894f7f24f07`; digest `sha256:44c6c7efdd7feb4b688bea19c1c158f6efcea49accb213b31c5426e0bd44dfa3`; published by Actions |
| ECS service/tasks | Cluster exists; no service/task/job execution yet |
| RDS | `godiffy-dev-postgres`, PostgreSQL 17.9, private encrypted Single-AZ `db.t4g.micro`, available with active RDS-managed master secret; TLS/SQL privileges not yet exercised |
| S3 image tests | Only local mock/presigned-policy tests; real S3 POST/CORS/download/delete/private-access tests not performed |
| Bootstrap/migration | Local PG17 and actual built-server HTTP tests pass; no AWS job run |
| IAM task roles | Execution/runtime/migration roles created with exact role-specific human-controlled boundaries; bootstrap role planned, exact master ARN bound |
| GitHub OIDC | Existing provider/trust unchanged; five exact DEV CI scopes and four immutable task boundaries human-bootstrapped |
| GitHub validation | Latest run 37630526181 succeeded for `0f7573b`; no AWS credentials/deployment in validation |
| Real AWS tests in this attempt | SSO/OIDC identity, CI policy validation/bootstrap and partial foundation apply; deployed app path not yet tested |
| Earlier blocker | SSO expiry resolved by the user; intermittent AWS API read timeouts were handled by bounded, idempotent bootstrap retries |
| Still unverified | Entire deployed DEV path, private ECR pull, RDS master privileges/TLS, real S3 semantics, ALB health, logs/metrics, alarms, task replacement and OIDC deployment |
| DEV recurring cost | Partial foundations now incur small usage charges; full small-dev envelope **$100–170/month**, subject to usage |
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
- [x] Commit/push Actions-only delivery workflows and offline/real-test safeguards.
- [x] Re-plan DEV; reject all deletions/unrelated resources; apply reviewed foundations and confirm convergence.
- [ ] Verify network, private endpoints/SGs, versioned private images, RDS and ECR.
- [x] Commit/build a linux/amd64 image; publish immutable SHA tag and record digest.
- [x] Plan/apply narrowly scoped private bootstrap/migration definitions and roles.
- [x] Run/check job exit codes; test RDS TLS and runtime SQL privileges.
- [x] Restrict bootstrap access in place, without deleting Terraform resources.
- [ ] Retain verified healthy service after its failed status read using approved Actions repair.
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

Partial DEV foundations already exist; do not abandon them as cost-free or run
cleanup without approval. Use this sequence under fresh scoped approval:

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

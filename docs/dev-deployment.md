# DEV deployment handoff — 7 October 2026

## Outcome: interview demo deployed; real HTTP/S3 smoke passed; Terraform converged

**URL:** http://godiffy-dev-alb-1345285825.eu-west-2.elb.amazonaws.com

The UI and `/health/live` / `/health/ready` returned HTTP 200. Real authentication,
database-backed sessions/rate limiting and private S3 integration **passed** in Actions.
The final release applied **8 additions, 1 in-place update, 0 deletions**, followed
by a refreshed **zero-change plan**. Process probes alone are not DB-health proof.
Use only disposable passwords and non-sensitive images: DEV is intentionally HTTP.

Account **218549829565**, region **eu-west-2**, environment **dev**.

- Running image: `218549829565.dkr.ecr.eu-west-2.amazonaws.com/godiffy-dev-application@sha256:52f132c7cb0264b64da5a6e6075757984c456a17f73e9b13b52bedb6b2852587`.
- Immutable tag: `a627234812426dec69faa1f970f5bb43cb821456`.
- Web definition: `arn:aws:ecs:eu-west-2:218549829565:task-definition/godiffy-dev-web:2`.
- Completed ECR OS scan: **no reported findings**. Dependency audit: zero advisories.
- Original Debian and rejected Alpine images are retained, not safe rollback candidates.

Application applies, images, DB jobs and ECS releases run **only in GitHub Actions**.
The preserved `portyard` / `PortyardAdministrator` SSO identity is used only for
read-only inspection and exact DEV IAM bootstrap. No Portyard infrastructure,
production, DNS, ACM, Cloudflare/Route 53, IAM users or permanent keys were changed.

## Actual final inventory

DEV state contains **102 managed records: 88 new DEV records and 14 exact imported
CI policies/attachments**; no taints remain. The independent backend has six records.
Final state inspected at serial **16**, after the successful release. Raw state and plans
remain private/owner-only, not committed or published as ordinary artifacts.

| Component | Actual inventory/status |
| --- | --- |
| Network | One dedicated `10.42.0.0/16` VPC; six subnets (public/task/database pairs in two AZs), one IGW, four managed route tables, six associations, one public default route; four dedicated SGs, five ingress/four egress rules |
| Private AWS access | Four interface endpoints (`ecr.api`, `ecr.dkr`, `logs`, `secretsmanager`) in `eu-west-2a`; one S3 gateway; no NAT or public task IP |
| ALB | `godiffy-dev-alb`, public in two AZs; one HTTP listener and `godiffy-dev-app` IP target group; service waiter and real HTTP/S3 smoke passed |
| ECS | `godiffy-dev-cluster` / `godiffy-dev-web`; one desired private Fargate task, successful steady-state waiter; 0.25 vCPU / 0.5 GiB; non-root/read-only amd64 image |
| Task definitions | Seven retained revisions: web/migrate/verify `:1` and `:2`, bootstrap `:1`; only final web `:2` is a service; no always-on jobs |
| RDS | `godiffy-dev-postgres`, PostgreSQL **17.9**, private encrypted Single-AZ `db.t4g.micro` in `eu-west-2b`; 20 GiB gp3, maximum 50 GiB, seven-day backups, deletion protection; available, restore-time metadata present |
| S3 | `godiffy-dev-images-218549829565-eu-west-2`; private, versioned, SSE-S3, ACL-disabled, TLS-enforced; eight bucket configuration records; exact ALB-origin CORS |
| Secrets | Three Terraform-managed containers (runtime, migration, disposable smoke fixtures); one RDS-managed master secret outside Terraform value/state management; master status active |
| Task IAM | Four `godiffy-dev-{execution,runtime,migration,bootstrap}` roles with four inline policies and role-specific human-controlled boundaries; bootstrap retained but denied |
| CI IAM | Nine dedicated policies: five attached DEV CI scopes and four task boundaries; existing OIDC provider/role/trust reused unchanged |
| Monitoring/scaling | Two seven-day log groups, **nine** explicit alarms, one `godiffy-dev-alarms` SNS topic/policy; one CPU target-tracking policy (60%) and scalable target bounded **1–2** tasks, with two AWS-managed tracking alarms |
| Account service roles | Exactly the approved RDS and ECS autoscaling roles created at **13:01:58** / **21:46:59 UTC**, respectively. Existing ECS/ELB service roles preserved |
| Backend | `godiffy-terraform-state-218549829565-eu-west-2`; protected SSE-S3/versioning/public-access/ownership/TLS/native-lock configuration; distinct bootstrap/dev/prod keys; backups retained |

Counts are Terraform configuration records, not 102 independent AWS services.
AWS-created default SG/route table, ENIs, RDS secret, service roles and autoscaling
alarms are not additional Terraform-managed records. All dedicated DEV resources
use `godiffy-dev-*` names and the required project/environment/management/purpose tags.

## Actions evidence and plan counts

| Evidence | Actual result |
| --- | --- |
| [Foundations plan 37619787401](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37619787401) | 73 additions and 14 exact CI imports; zero changes/deletions |
| [Final foundation apply 37630947179](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37630947179) | Last eight additions completed; refreshed zero-change plan |
| [Initial image 37628283144](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37628283144) | Immutable original amd64 digest published; subsequently found severe OS issues |
| [Jobs apply 37633228998](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37633228998) | Six additions; bootstrap/migration/runtime verification each **exit 0**; convergence |
| [Initial service apply 37636634654](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37636634654) | Created a healthy service; provider status-read permission failed, leaving a taint |
| [Approved retention 37686483704](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37686483704) | Verified original creation/tags/image/private network/container and ALB health; cleared only the failed-read taint; remaining plan 5 add / 0 change / 0 delete |
| [Validation 37690611200](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37690611200) | Patched build passed; 27 Terraform mock runs, 32 Python guard tests, 15 app tests/one DB skip, local PostgreSQL/built-server HTTP integration, types/format/advisories and container/production guards |
| [Patched image 37690896101](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37690896101) | Immutable replacement published; completed exact-digest OS scan, no reported findings |
| [Patched service plan 37691183692](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37691183692) | **8 add / 1 in-place change / 0 delete**; three new definitions, three alarms and scaling target/policy; no new bootstrap revision |
| [Patched service apply 37691404457](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37691404457) | **8 added / 1 changed / 0 destroyed**; old/new runtime verifier jobs exited **0**; real HTTP/S3 smoke **PASS**; final refreshed plan **no changes** |

Every apply uses a freshly generated saved plan with the reviewed semantic
fingerprint. Ordinary Terraform deletion/replacement and CI self-IAM mutation remain
fail-closed. Production is unapplied; its old 76-addition plan is historical design
evidence, not a current apply input.

Release-plan fingerprint:
`e29efaf26ea1bb5b863bcf1cb8821b2315feac2f2bd0803262e423cdbec24cad`.

## Tests, security boundaries and focused fixes

**Passed in AWS:** RDS-managed bootstrap and direct application-secret writes,
ordered migration, CA-validated RDS TLS, plaintext rejection, runtime SQL privilege
restrictions and denial of master/migration secrets. Service activation reran the
private runtime verifier before apply and with the final image afterward. Real
HTTP smoke exercised allowed signup, denied outsider/wrong password, persisted
login/sessions/rate limiting, anonymous gallery denial and cross-origin denial.
Real S3 tests exercised exact-origin POST/GET preflight, fixed MIME/checksum/size
policy, altered-policy/checksum/oversize rejection, private HEAD denial, other-user
complete/download/delete/list isolation, verified finalization, identical download
bytes, idempotent deletion and deleted version/URL denial. Only this invocation's
test images were deleted; disposable accounts and pending upload versions remain.
Initial `migrate:1` exited 0; `migrate:2` was registered but not executed because
this packaging-only release had no schema change. Secret values did not pass
through Terraform or get printed by the deployment/job/smoke scripts.

**Passed without AWS deployment credentials:** 27 mocked Terraform runs, 33 Python
guard tests, 15 application unit tests, local PostgreSQL integration (38 assertions),
built-server HTTP integration (49 assertions), frozen dependency audit (zero
advisories across 216 packages), strict types/format/build and non-root/read-only
amd64 production-failure guards. Mocks are kept distinct from real AWS evidence.
The deployed-code validation run contains 32 Python tests; the final exact-scaling
permission regression raises the locally passing count to 33. Access Analyzer
reported no findings for the final narrowed CI policy.

Focused repairs preserved resources rather than replacing them:

- CI log-tag ARN, EC2 endpoint/rule attachment, valid SNS actions and regional
  RDS metadata reads were corrected. Failed-new empty log/uninitialized DB taints
  were cleared only after the approved ownership/freshness/empty-state checks.
- `ecs:ListServiceDeployments` / `ecs:DescribeServiceDeployments` are now limited
  to the exact DEV service/deployment ARN. The running-service repair required
  separate approval. Its six-hour guard first expired unchanged; the user then
  approved pinning **2026-10-07 14:27:37.018 UTC**, not broadening the age window.
- Bootstrap trust/inline policy deny use; its human-owned boundary explicitly
  denies secret reads/writes and CI no longer has bootstrap `PassRole`. Actions
  cannot restore those permissions or edit its own policies/boundaries.
- After creation, human bootstrap pinned scaling writes to the actual ARN
  `arn:aws:application-autoscaling:eu-west-2:218549829565:scalable-target/0ec5ce51b18de9d74bb1b5343ca6f527a47e`.
  Only `godiffy-dev-ci-control` changed, to version **v5**; v1–v4 were preserved.
  Bootstrap retirement and the original OIDC trust remained unchanged. Further
  version changes must stop for review at IAM's five-version limit, not delete history.
- ECR found **6 critical/19 high/12 medium/6 low** OS findings in the Debian image,
  despite the clean app dependency audit. The unpatched Alpine candidate
  `sha256:b50a6546ba878013d76bdeba99887855233ce2643f3049e2b21bfc09869f2c5d`
  had **2 critical/8 high/1 medium** and was **not deployed**. Final packaging pins
  Bun 1.4.2 Alpine plus OpenSSL **3.5.9-r0** and zlib **1.3.2-r1**. Publication and
  jobs/service deployment now require a complete scan with zero critical/high findings.
- A `tee` pipeline masked the first scan-startup failure. DEV workflows now
  explicitly use Bash `pipefail`; scan creation/completion has a bounded wait.
  The unavailable older OpenSSL fix pin failed credential-free CI, not deployment.
- Release history retains actual bootstrap-definition digests separately, so a
  repeated new release cannot create a fresh retired bootstrap revision. Recovery
  waits for the exact replacement's container **and ALB** health before session reuse.

## Remaining verification and deliberate limitations

- The user clarified this is a simple Terraform interview demo. Work stops after
  the working release, basic end-to-end proof, converged plan and handoff—not a
  broader production-readiness project. The optional `dev-verify.yml` full inventory,
  live CI-secret-denial/log-sampling/metric audit and task-replacement exercise were
  **not run**. Recovery helpers are implemented/tested locally, not proven in AWS.
- Interactive-browser testing is unavailable (desktop browser disconnected).
  Protocol-level CORS preflight is not a claim of every browser behavior.
- No production HTTPS/DNS/invitation-ownership, load/autoscaling stress, backup
  restore, AZ/regional failover or malware/full-image-decoding proof is claimed.
  RDS backup metadata is not a successful restore. Scans do not cover every static
  library or prove absence of vulnerabilities.
- Process-only health probes can remain healthy during DB failure. Better Auth
  warns about its generated `rateLimit.lastRequest` bigint; Nitro is beta and
  Vite/Rolldown emits module-directive warnings. Tested behavior does not erase
  those upgrade/production-review risks.
- No alert email recipient or AWS Budget was added without approval. SNS routing
  exists, but an unconfirmed/unsubscribed topic is not human alert delivery.

## Costs, production differences and retirement

The one-task approved design is approximately **$86.50/month** in always-on fixed
infrastructure before usage, alarms and ECR/object storage. The worksheet's
one-LCU/10-GB-ECR illustration is **$93.63/month**; allow **$100–170/month**, not a
measured bill or hard cap. Four one-AZ interface endpoints cost about $32.12/month;
there is no NAT. RDS in `eu-west-2b` and tasks/endpoints in `eu-west-2a` incur
usage-dependent cross-AZ traffic. A second steady task adds about $10.36/month;
release overlap and retained versions/snapshots/logs also cost money. See [costs](costs.md).

Production remains separate/unapplied: HTTPS and registration-review gates,
two task/endpoint AZs, at least two tasks, Multi-AZ larger RDS, longer retention,
access logs and confirmed notifications are design differences, not deployed claims.
`godiffy.com` / `dev.godiffy.com` were not activated.

**Teardown requires separate explicit approval.** The exact Actions-only retirement
commands, final-snapshot/data-version/protection safeguards and CI grants removed
last are in [teardown.md](teardown.md). Preserve backend/local backups, original
OIDC/SSO identities, service-linked roles and every Portyard/production resource.
No infrastructure destroy, resource replacement or routine cleanup was performed.

To refresh the same deployed configuration without a local application apply:

```sh
gh workflow run dev-deploy.yml --repo MichaelFisher1997/Cloudpay-demo --ref master \
  -f phase=service -f operation=plan \
  -f image_digest=sha256:52f132c7cb0264b64da5a6e6075757984c456a17f73e9b13b52bedb6b2852587
```

Actions reconstructs both retained release digests from state, and retains only
the original bootstrap digest. The live release has `bootstrap_enabled=false`,
`bootstrap_retained=true`, `service_enabled=true`, `database_ready=true`, with
`smoke-owner@godiffy.invalid`, `smoke-other@godiffy.invalid`, `interview@godiffy.invalid`
as the disposable DEV allowlist. Do not apply the default foundations-only inputs
against a live service or reuse an old saved plan.

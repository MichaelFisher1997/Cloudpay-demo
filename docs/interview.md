# Interview notes — evidence, not aspiration

## What is actually deployed

DEV runs at **http://godiffy-dev-alb-1345285825.eu-west-2.elb.amazonaws.com** in
account `218549829565`, London. It uses a two-AZ public ALB, private Fargate task,
private Single-AZ RDS PostgreSQL 17.9 and private versioned S3. Four single-AZ
interface endpoints plus an S3 gateway replace NAT. The independent six-resource
state backend retains encryption, versioning, native locking and protected backups.

Actual private bootstrap, migration and runtime-verification jobs exited 0.
They proved RDS-managed initialization, Secrets Manager writes, validated TLS,
plaintext rejection and restricted runtime SQL/master/migration-secret access.
Initial service creation reached AWS but Terraform's status reader lacked a
permission; the healthy original service was retained through an explicitly
approved guarded Actions repair, not deleted/replaced.

Use [the deployment handoff](dev-deployment.md) for the **current final digest,
HTTP/S3/recovery results, inventory, costs and remaining gaps**. Do not present a
candidate image's publication or process-only probes as complete verification.
All application deployments/image pushes/jobs run in Actions using OIDC; human
SSO was restricted to reads and narrow DEV policy bootstrap. Production, Portyard,
DNS and certificates were untouched.

The current Clerk image is
`sha256:0b9490fbfef66443dbca66960709e4a7c2510890b50396423fcaf369915843d1`.
[Clerk cutover 37700319765](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37700319765)
applied **3 additions / 1 in-place update / 0 deletions**, completed the approved
data reset and private DB verification, and finished with **no Terraform changes**.
Anonymous live Google-only UI/OAuth handoff passed; the owner reported successful
real Google/gallery/S3 testing and rejection of an unapproved Google account.
That authenticated proof is manual, not automated. The allowlist is enforced by Clerk and
independently by the API, without private-task internet egress.

The prior password-release image was `sha256:52f132c7cb0264b64da5a6e6075757984c456a17f73e9b13b52bedb6b2852587`,
with no ECR OS findings. [Release 37691404457](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37691404457)
applied **8 additions / 1 in-place update / 0 deletions**, passed real auth/private
S3 ownership/upload/download/delete smoke, and finished with **no Terraform changes**.
For the interview, lead with modules, remote state/locking, reviewed plan/apply and
OIDC; the app simply demonstrates that the infrastructure works together.

## What can be demonstrated locally

- Cohesive Terraform modules, thin dev/prod roots, pinned versions and **40 mocked tests**.
- DEV no-delete/fingerprint plans, focused retry records and retained release history;
  the old 76-addition production plan remains historical/unapplied.
- TanStack/Bun gallery with offline Clerk bearer verification, exact verified-email
  restrictions, stable user-ID ownership and direct private version-pinned S3 transfers.
- 22 unit tests plus 35 Python guard tests; local PG17/built-server HTTP integration with 54 assertions;
  non-root/read-only amd64 container smoke and zero dependency advisories at scan.
- Cost comparison, explicit migration/runtime/master separation and runbooks.
- Actual GitHub [Clerk validation run 37699566022](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37699566022)
  passed against committed code, including the built server/local PostgreSQL and
  container checks. It is credential-free validation, not deployed AWS verification.

Keep local mocks separate from real AWS evidence. ECR OS scanning caught vulnerable
base packages that the clean app dependency audit did not cover; patches and a
fail-closed scan gate are part of the release, not a claim of zero security risk.
Task replacement, full metric/log auditing, automated authenticated-browser testing,
production failover/load and actual backup restore remain
separate unverified work. A browserless CORS preflight verifies protocol headers,
not every browser behavior.

## Architecture rationale to discuss

For the test's **production-ready Terraform** requirement, show
[the production configuration walkthrough](production-readiness.md): live Clerk
inputs now reach ECS, activation gates are regression-tested, and the HA/security
settings differ deliberately from cheap DEV. Do not confuse deployable configuration
with completed production OAuth/TLS/CI approvals or measured recovery guarantees.

ALB → private Fargate → private PostgreSQL/S3 keeps the application stateless.
Direct signed browser transfers avoid streaming image bytes through compute.
Endpoints remove NAT from the small DEV design, with an explicit service/API and
one-AZ availability trade-off. Runtime, migrations and initialization have distinct
DB/IAM privileges; Terraform manages secret containers, not passwords.

DEV is deliberately small and temporarily HTTP-only. Production is separately
designed for two task AZs/replicas, Multi-AZ RDS, dual-AZ endpoints, backups and
HTTPS approval, but remains undeployed. Clerk and the API enforce verified-email
allowlisting; that is not a production invitation/audit design. Private ALB-to-task
HTTP and the public DEV HTTP connection are not end-to-end encryption.

Use [architecture.md](architecture.md) for all six Well-Architected pillars and
[costs.md](costs.md) for the usage-sensitive $100–170/month planned DEV envelope.
ACM/custom-domain/DNS integration is intentionally postponed and unauthorized.

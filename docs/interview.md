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

The final image is `sha256:52f132c7cb0264b64da5a6e6075757984c456a17f73e9b13b52bedb6b2852587`,
with no ECR OS findings. [Release 37691404457](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37691404457)
applied **8 additions / 1 in-place update / 0 deletions**, passed real auth/private
S3 ownership/upload/download/delete smoke, and finished with **no Terraform changes**.
For the interview, lead with modules, remote state/locking, reviewed plan/apply and
OIDC; the app simply demonstrates that the infrastructure works together.

## What can be demonstrated locally

- Cohesive Terraform modules, thin dev/prod roots, pinned versions and **27 mocked tests**.
- DEV no-delete/fingerprint plans, focused retry records and retained release history;
  the old 76-addition production plan remains historical/unapplied.
- TanStack/Bun gallery with ownership checks, PostgreSQL-backed auth/sessions and
  direct private version-pinned S3 transfer design.
- 15 unit tests plus 33 Python guard tests; local PG17/built-server HTTP integration with 49 assertions;
  non-root/read-only amd64 container smoke and zero dependency advisories at scan.
- Cost comparison, explicit migration/runtime/master separation and runbooks.
- Actual GitHub [validation run 37607324492](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37607324492)
  passed against committed code, including the built server/local PostgreSQL and
  container checks. It is credential-free validation, not deployed AWS verification.

Keep local mocks separate from real AWS evidence. ECR OS scanning caught vulnerable
base packages that the clean app dependency audit did not cover; patches and a
fail-closed scan gate are part of the release, not a claim of zero security risk.
Task replacement, full metric/log auditing, interactive-browser, production failover/load and actual backup restore remain
separate unverified work. A browserless CORS preflight verifies protocol headers,
not every browser behavior.

## Architecture rationale to discuss

ALB → private Fargate → private PostgreSQL/S3 keeps the application stateless.
Direct signed browser transfers avoid streaming image bytes through compute.
Endpoints remove NAT from the small DEV design, with an explicit service/API and
one-AZ availability trade-off. Runtime, migrations and initialization have distinct
DB/IAM privileges; Terraform manages secret containers, not passwords.

DEV is deliberately small and temporarily HTTP-only. Production is separately
designed for two task AZs/replicas, Multi-AZ RDS, dual-AZ endpoints, backups and
HTTPS approval, but remains undeployed. Email allowlisting is not verified
invitation security, and private ALB-to-task HTTP is not end-to-end encryption.

Use [architecture.md](architecture.md) for all six Well-Architected pillars and
[costs.md](costs.md) for the usage-sensitive $100–170/month planned DEV envelope.
ACM/custom-domain/DNS integration is intentionally postponed and unauthorized.

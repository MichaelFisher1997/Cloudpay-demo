# Interview notes — evidence, not aspiration

## What is actually deployed

Only the dedicated Godiffy Terraform S3 backend is live: versioning, SSE-S3,
public-access blocking, ACL disabling, TLS enforcement and native lockfiles.
The approved bootstrap applied **6 additions, no changes/deletions** and was
verified during the build-and-plan stage. Local backups were retained securely.

The application platform has **not** been deployed. DEV deployment is approved,
but expired AWS SSO authentication currently blocks it. No ALB application URL
or real AWS application test result should be presented. See
[deployment status](dev-deployment.md).

## What can be demonstrated locally

- Cohesive Terraform modules, thin dev/prod roots, pinned versions and 24 mocked tests.
- 72-addition DEV and 76-addition prod foundation plans, neither applied.
- TanStack/Bun gallery with ownership checks, PostgreSQL-backed auth/sessions and
  direct private version-pinned S3 transfer design.
- 13 unit tests; local PG17/built-server HTTP integration with 49 assertions;
  non-root/read-only amd64 container smoke and zero dependency advisories at scan.
- Cost comparison, explicit migration/runtime/master separation and runbooks.
- Actual GitHub [validation run 37607324492](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37607324492)
  passed against committed code, including the built server/local PostgreSQL and
  container checks. It is credential-free validation, not deployed AWS verification.

Do not describe local mocks as successful RDS, S3 browser CORS, Fargate networking,
OIDC delivery, failover or restore testing. The AWS deployment gap must be stated.

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

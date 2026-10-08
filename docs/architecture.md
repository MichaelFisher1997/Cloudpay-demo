# Godiffy platform architecture — deployed DEV, proposed production

## Scope and boundaries

Target account `218549829565`, London `eu-west-2`; dedicated names
`godiffy-dev-*` / `godiffy-prod-*` and tags `Project=godiffy`,
`Environment=dev|prod`, `ManagedBy=terraform`,
`Purpose=cloudpay-technical-assessment`.

The backend and DEV platform have been deployed through GitHub Actions; see
[deployment status](dev-deployment.md) for the current digest, inventory and actual
verification evidence. The production column remains a design, not deployed resources.
Production and domain/TLS work are not authorized. The `portyard` SSO
profile and `PortyardAdministrator` identity remain intact and are human credentials
only. No Portyard VPC, application, database, bucket or state is referenced/imported.
No AWS keys, IAM users, new OIDC provider, or AdministratorAccess CI grant is needed.

## Runtime and networking

| Concern | Approved DEV design | Production draft |
| --- | --- | --- |
| VPC | Dedicated `10.42.0.0/16` | Dedicated `10.43.0.0/16` |
| Subnets | Public, task, isolated DB pair in `eu-west-2a/b` | Same six-subnet pattern |
| ALB | Public two-AZ ALB; initial HTTP on ALB hostname | Two-AZ ALB; no listener until approved ACM integration |
| Fargate | Linux x86-64, 256 CPU / 512 MiB; one replica in endpoint AZ | Same initial size; two minimum replicas across both AZs |
| Scaling | CPU target 60%, min 1/max 2 | CPU target 60%, min 2/max 4 |
| RDS | PostgreSQL 17.9, `db.t4g.micro`, Single-AZ, 20 GiB gp3 | `db.t4g.small`, Multi-AZ, 50 GiB gp3 |
| Storage growth limit | RDS max 50 GiB | RDS max 200 GiB |
| Backup/retention | RDS 7 days; app/DB logs 7 days | RDS 14 days; logs 30 days; ALB access logs 90 days |
| AWS egress | Four interface endpoints in one AZ plus S3 gateway | Four interface endpoints in both AZs plus S3 gateway |

Subnet roles are distinct: public subnets have the only IGW default route; tasks
have no internet default route; DB subnets have neither internet nor S3 gateway
routing. Tasks never receive public IPs. Fixed CIDRs are not peered to other VPCs;
confirm future connectivity requirements before changing address allocations.

Security-group flows: internet → ALB 80/443, ALB → tasks 3000, tasks → DB 5432,
tasks → interface endpoints 443, tasks → regional S3 prefix list 443. DB/endpoints
accept only the dedicated task SG. SG return traffic is stateful; no SSH, public
DB port, all-ports task ingress or blanket task internet egress is configured.
Auth IP normalization relies on ALB-only task ingress and explicitly managed
ALB XFF append mode without client ports; caller-supplied earlier hops are discarded.

Endpoint services are `ecr.api`, `ecr.dkr`, `logs`, `secretsmanager`, with private
DNS, plus S3 gateway routes in both task subnets. ECR image layers need the
AWS-owned `prod-eu-west-2-starport-layer-bucket`: the gateway policy explicitly
permits its GetObject, not another project's storage. Endpoint policies are not
credentials: task IAM remains the data-access boundary. Adding outbound SaaS,
runtime package installation, external email, SSM/ECS Exec or different AWS APIs
would require an explicit networking change; none is silently assumed to work.

One dev endpoint AZ is an intentional availability compromise. Pinning the dev
task there avoids cross-AZ pulls. Production endpoints exist in both AZs. See
[costs](costs.md) for zonal/regional NAT alternatives and current billing.
The actual DEV task/endpoints use `eu-west-2a`, while RDS selected `eu-west-2b`.
Database traffic therefore crosses AZs; account for transfer/latency rather than
replacing the healthy database merely to align placements.

## Application and data flow

Single-container TanStack Start/Bun with Clerk development Google authentication.
The browser obtains short-lived sessions; the server verifies bearer tokens offline
with a pinned public key. Gallery state is in RDS/S3, not on task disk, so scaling
and rolling replacements do not need sticky sessions or an internet route to Clerk.
The intentionally minimal product is a per-user gallery, not a complex gallery
sharing/social platform.

1. Clerk permits only named, approved Google-account emails on sign-up/sign-in.
   The API independently requires a signed verified email on the same allowlist.
   Production still requires separate Clerk/OAuth/HTTPS approval.
2. Every image operation checks the signed issuer, exact origin, expiry, session
   and stable Clerk user ID; gallery SQL always filters by that owner ID.
3. Server creates pending metadata and a five-minute signed S3 POST with fixed
   key, JPEG/PNG/WebP MIME, SHA-256 and a 10 MiB maximum.
4. Browser sends bytes directly to S3 over HTTPS; no AWS credentials are embedded.
5. Completion checks size, checksum, version and bounded image header/dimensions;
   copies the pinned source version into `images/`, records its destination version,
   and marks metadata ready. Claims handle concurrent completion and deletion races.
6. Downloads are owner-authorized two-minute signed URLs for the recorded version.
   Delete tombstones metadata and retry-safely deletes that exact version.

S3 is private, ACL-disabled, SSE-S3 encrypted and versioned. CORS has exactly the
application origin, not `*`. Do **not** deny all non-VPC requests: browser presigned
transfers must work outside the endpoint. Pending-object lifecycle expiry is not
immediate; versioned current/noncurrent cleanup can take days. Completed-image
versions are not blindly expired because the DB pins versions. Orphan reconciliation
and retained-version storage are explicit operating responsibilities.

Image-header checks are not malware scanning, full decoding or metadata stripping.
Production invitation verification and content threat requirements remain review
gates; see [app limits](../app/README.md). DEV uses non-sensitive images only:
Google credentials stay on HTTPS pages, but gallery bearer tokens cross the HTTP
ALB connection. PostgreSQL, S3 and browser-to-Clerk traffic already use TLS.

## Credentials and jobs

RDS manages the master password in Secrets Manager; Terraform sees the ARN, never
the value. Terraform creates two empty secret containers for runtime and schema
credentials, not secret versions. One-off Fargate initialization writes generated
values directly to AWS and creates restricted PostgreSQL roles. A separate
schema-owner job performs serialized, reviewed migrations.

| IAM role | Access |
| --- | --- |
| Execution | Pull dedicated ECR repository and write dedicated log streams; ECR auth token requires `Resource=*` |
| Runtime | Read runtime secret only; narrowly scoped pending/image S3 object actions |
| Migration | Read schema-owner secret only; no master secret or secret writes |
| Bootstrap, initialization only | Initially read exact master/runtime/migration secrets and write the two app secrets; now retained with denied trust/secret access and no CI `PassRole` |

Service activation cannot coexist with enabled bootstrap privilege. The denied
role/definition are retained; deleting them needs separate approved IAM cleanup.
The runtime SQL user has DML, not schema ownership/DDL. Jobs do not run during
Terraform apply via `local-exec`; operators run and check them after approved plans.

DEV uses default AWS-managed encryption: SSE-S3, RDS/Secrets Manager managed
keys. A customer-managed KMS key adds cost, lifecycle and permissions complexity;
it needs a stated compliance/control requirement rather than being decorative.
RDS master rotation is AWS-managed; app credentials are cached per process and
must be manually rotated with coordinated task restarts. No automatic app rotation
is claimed. State, plans and local backups remain sensitive even without passwords.

## Terraform boundaries

```text
terraform/bootstrap/                 # independent, live state bucket root
terraform/environments/{dev,prod}/   # thin roots, distinct backend keys
terraform/modules/godiffy/          # environment composition and monitoring
terraform/modules/networking/       # VPC, routes, subnets, SGs and endpoints
terraform/modules/storage/          # private images and prod ALB logs
terraform/modules/database/         # RDS and empty secret containers
terraform/modules/application/      # ECR, ALB, ECS, job/runtime IAM and scaling
```

Modules follow cohesive boundaries, not one wrapper per resource or an arbitrary
generic AWS framework. Roots pin the CLI/provider, use an account allowlist, and
pass a reviewed release digest. The default full-foundation plans do **not** contain
fake images, service tasks, migration/bootstrap task definitions, or master-access
roles. A release ECR lookup verifies the digest exists in the dedicated repository.
DEV supplies human-controlled task permission boundaries; the production root
currently supplies none, so do not present boundaries as a shared production control.
Use the default Terraform workspace only: dev/prod are separate roots and state
keys, not CLI workspaces. Future scoped backend IAM must reject alternative paths.
Only desired task count is ignored for autoscaling; Terraform owns task definitions
and service configuration, avoiding a second conflicting deployment owner.

Production guards require TLS, migrations acknowledged, an alarm recipient and
an explicit review switch, plus live Clerk public configuration and named emails.
Production root inputs now reach the application module; development issuers and
key/issuer mismatches are rejected. See [production readiness](production-readiness.md)
for tested guards and remaining launch evidence. Terraform booleans are not organizational approval
boundaries: IAM/GitHub Environment protections must enforce that separately.
DEV-only OIDC delivery is enabled and tested; no production deployment authority
was granted under the historical master-branch flow. The intended active branch is
now `dev`; that exact OIDC trust change still needs approval. Production remains a
module-reuse example/template, without a deployment pipeline. See [delivery](delivery.md).

## Six Well-Architected pillars

| Pillar | Deliberate controls and trade-offs |
| --- | --- |
| Operational excellence | Version-controlled modules/locks, mock tests, saved/audited plans, app/DB integration tests, runbooks, explicit migration/release ownership; staging proof remains required |
| Security | Dedicated resources, temporary SSO/OIDC, private tasks/DB, owner checks, CSRF, runtime/migration/master separation, encrypted private versioned storage; dev HTTP and private HTTP ALB→task hop are explicit exceptions |
| Reliability | Prod two-AZ ALB/tasks/endpoints, Multi-AZ RDS, min two replicas, circuit-breaker rollback, backups/final snapshots, healthy-target alarm; no regional DR claim |
| Performance efficiency | Small measured starting sizes, direct-to-S3 transfers, five-connection app pools and bounded uploads; load testing must validate memory/CPU/DB-credit headroom |
| Cost optimization | Endpoint-only pricing compared with NAT, short dev log retention, no Kubernetes/Redis/WAF by default, dev reduced redundancy; budgets are planning envelopes, not cost caps |
| Sustainability | Right-size tasks, scale only on demand, lifecycle abandoned uploads, retain only justified logs; avoid unnecessary NAT/extra services, measure before considering ARM image migration |

The private ALB→task hop is **HTTP**, not end-to-end TLS. Approve that trust-boundary
decision explicitly or implement backend HTTPS before any production rollout.
Backup retention/DR objectives, production approver availability, verified invites,
budget and final release/CI privileges remain open decisions, not inferred approvals.

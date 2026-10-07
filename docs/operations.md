# Godiffy operations and staged rollout

**Use the user's current authorization, not this runbook as blanket permission.**
DEV-only deployment is now approved within the small-dev design and **must run
from GitHub Actions**. Human SSO is limited to read-only verification and narrowly
scoped DEV CI IAM bootstrap; it is not the application deployment identity. Review each real
DEV plan and stop if it includes deletions, unrelated/Portyard/production resources
or unexpected scope. Production, ACM and DNS work below remain future runbook
instructions, not authorized actions.
Never operate on Portyard resources; use exact Godiffy identifiers from outputs.
The initial foundations/bootstrap sequence below is historical setup, not authority
to rerun it against the live service. Bootstrap stays retired. Current authentication,
the one-off approved reset and manual Google proof are in [clerk-dev.md](clerk-dev.md).

## 1. Review foundations

Confirm architecture, proposed endpoint design, DB sizing/retention, budgets and
alert recipient. Default dev/prod roots contain foundations only; no placeholder
task image or automatically executed DB job. The DEV foundation rollout created 73
new records and imported 14 exact CI policies/attachments; the old production
foundation design plan has 76 additions, never applied. These are review counts, not approval to
skip the agreed incremental review. If smaller infrastructure slices are desired,
prepare/review a staged code change; do not normalize routine `-target` deployment.

From repository root, dispatch the DEV-only workflow:

```sh
gh workflow run dev-deploy.yml --ref master -f phase=foundations -f operation=plan
gh run view <returned-run-id> --log
```

Account must be `218549829565`. `check-dev-plan.py` audits the saved plan for DEV
scope, known dangerous properties, cost shape, tags, account and no deletions or
replacements; it is **not** blanket apply approval, a
complete IAM analyzer, or proof of runtime correctness. Inspect values still unknown
at plan and verify them after apply. Saved plans are ignored, owner-only and runner-local;
raw JSON/state are not published. The initial Actions plan additionally imports
the exact nine human-bootstrapped policies and five existing attachments without
IAM mutations. These are not Portyard/application imports.
If SSO expires, renew the existing profile; do not replace it or create AWS keys.

After review within current DEV authorization, copy the exact reported fingerprint:

```sh
gh workflow run dev-deploy.yml --ref master -f phase=foundations -f operation=apply \
  -f expected_fingerprint=<reviewed-plan-fingerprint>
```

Actions re-plans, rejects any semantic difference and applies that saved plan in
the same runner. No local application apply is permitted. Foundation
ALB/RDS/endpoints cost money even before tasks run. The backend is independent of
either environment's teardown.

Verify exact Godiffy VPC/routes/SGs, endpoint ENIs/private DNS/S3 layer access,
private RDS and forced/verified TLS, public-access controls/versioning, ECR policy,
log retention and alarm topic/subscription. Confirm PostgreSQL minor is still
orderable in London before applying; 17.9 was returned by the regional preflight.
Allow the initial S3 versioning propagation window before upload/state writes.

## 2. First immutable image and job definitions

After an approved ECR foundation apply, dispatch `dev-image.yml` to build linux/amd64 and push to the dedicated
`godiffy-dev-application` repository with an immutable unique release tag, inspect
ECR scan results, and record the manifest digest. Runtime never downloads packages
or public CA bundles: the image contains code/dependencies and the public RDS CA.
Image publication and jobs/service plans now fail closed unless that exact digest
has a completed ECR OS scan without critical/high findings. Do not roll back to the
retained initial Debian digest with known severe findings; select a scan-clean artifact.

Dispatch the job-definition plan with the actual reported digest:

```sh
gh workflow run dev-image.yml --ref master
gh workflow run dev-deploy.yml --ref master -f phase=jobs -f operation=plan \
  -f image_digest=<actual-DEV-ECR-manifest-digest>
```

Placeholders intentionally fail validation. Do not copy digests from mocked
tests or use `latest`. Before the jobs apply, human bootstrap binds the bootstrap
boundary to the exact master secret ARN from the dedicated DEV RDS metadata (not
its value). Review new bootstrap role/policy and definitions; use the jobs plan's
fingerprint for an Actions apply. Terraform itself does not execute jobs; the
workflow checks each approved job's exit status afterward.

## 3. Initialize and migrate

The Actions jobs phase uses deployment outputs for cluster, job-definition ARNs, exact private task subnets,
task SG, DB host and secret ARNs. Run one bootstrap Fargate task with `assignPublicIp`
disabled and its dedicated task role; wait for STOPPED and check its essential
container exit code is zero. Watch only the dedicated CloudWatch log group, without
dumping secret values. Then run the migration definition with its separate role and
check exit code zero. Waiting for task STOPPED alone does not prove job success.

Verify schema/runtime grants and that repeated bootstrap does not rotate values.
Runtime must not read master/migration secrets or create schema objects. Test actual
RDS master-role behavior: local PostgreSQL tests are not AWS `rds_superuser` proof.
Do not put generated credentials in Terraform, task definition secret values,
GitHub plaintext outputs, local tfvars, container layers or logs.

After successful migration, restrict temporary bootstrap privileges. The service
phase sets `bootstrap_enabled=false` and `bootstrap_retained=true`: the role's
trust and secret policy become explicit denials, while resources/definitions remain.
Human retirement additionally denies all bootstrap secret access in its boundary
and removes CI bootstrap `PassRole`; Actions cannot restore those human-owned
permissions. The current authorization forbids applying plans with resource deletions, even
for this cleanup. Service validation rejects leaving master-access bootstrap enabled.

## 4. Activate dev service and verify core behavior

Dispatch `phase=service` with the scan-clean immutable digest. Actions supplies
retired-bootstrap/ready-database inputs and public Clerk DEV configuration, including
the named-email API allowlist. Review the saved plan and supply its fingerprint.
The private runtime verifier runs before apply. After the service reaches steady
state and drains legacy auth, Actions migrates ownership and reruns DB verification
and Clerk boundary smoke. Only the separately approved first cutover sets
`reset_dev_data=true`; ordinary releases must leave it false. Until separately
authorized TLS integration, use only the existing HTTP ALB hostname.

Check:

- Tasks have no public IP and pull ECR layers through approved endpoints.
- ALB sees healthy tasks; `/health/live` and `/health/ready` are process-only probes,
  not a claim that RDS/S3 are available. DB outages must not trigger health-probe loops.
- Approved Google sign-in, named-email rejection and cross-origin mutation denial.
  Real Google/gallery/S3 browser proof is manual; anonymous smoke cannot prove it.
- JPEG/PNG/WebP upload, oversized/type/checksum rejection, version-pinned completion,
  download and retry-safe deletion. Browser S3 POST/CORS must be tested for real.
- A second user's session cannot list/read/finalize/download/delete another's image.
- Logs contain no passwords, raw SQL secrets, signed URLs or credentials.
- Alarms reach a **confirmed** SNS subscriber; supplying an email is not confirmation.
- Load tests validate 512 MiB memory, CPU targets, DB pool/max connections and
  RDS burst-credit usage before any sizing claims or production promotion.

Use non-sensitive photos only; gallery bearer tokens cross HTTP even though Google
credentials stay on HTTPS pages. The
actual AWS evidence and remaining gaps are in [dev-deployment.md](dev-deployment.md).
Protocol-level POST/CORS checks do not substitute for an interactive browser or
production load/restore testing.

## 5. Domains/TLS — final integration

After core dev verification and separate approval:

1. Request the London ACM certificate and output validation CNAMEs in a focused
   reviewed change; no certificate or DNS record has been requested overnight.
2. Manually create validation CNAMEs in Cloudflare: DNS-only, exact ACM values,
   not flattened validation records. Wait for certificate ISSUED.
3. Set the certificate ARN and exact HTTPS `app_url`; keep
   `https_redirect_enabled=false`. Apply the separately approved HTTPS listener,
   origin/CORS/cookie configuration. Adding a certificate does not redirect early.
4. Manually point `dev.godiffy.com` to the dev ALB. Later production points
   `godiffy.com` to its own ALB; DNS-only apex CNAME flattening is separate from
   validation CNAMEs. Cloudflare remains outside Terraform initially.
5. Verify custom-host HTTPS, certificate, cookies, origins and direct S3 transfers;
   then plan/approve `https_redirect_enabled=true`. Redirect targets the custom
   hostname, never the ALB hostname.

Production never forwards plaintext HTTP: before approved redirect it returns a
fixed rejection. Production service activation also requires separate review,
certificate and alarm recipient. Review private ALB→task HTTP separately: public
TLS termination does not encrypt that internal hop.

## Monitoring, incidents and rollback

Built-in CloudWatch metrics monitor ALB/target 5xx, unhealthy targets, RDS CPU/free
storage/connections; an enabled service additionally gets memory/CPU and minimum
healthy-target alarms. Missing healthy-target data breaches that alarm. Other
missing metrics do not breach. Container Insights is deliberately not enabled.
RDS/app logs have bounded retention; production ALB logs have a dedicated private
90-day bucket. There is no paid external tracing or monitoring dependency.

- **Failed release:** circuit breaker rolls back an unhealthy service deployment;
   inspect events and dedicated logs. For deliberate rollback, plan the prior known
   compatible Clerk ECR digest and obtain approval. **Legacy password releases are
   incompatible after the reset**, even if their image scan was clean. Preserve
   historical images; no independent CLI owner should fight Terraform.
- **DB failure/storage:** inspect only this DB's metrics/latest-restorable time,
  failover events, application 5xx and connection headroom. Scaling tasks is not a
  remedy for an exhausted database. DB-dependent requests can fail even if process
  probes stay healthy.
- **Migration failure:** stop and inspect the exact job; do not repeat the reset
  blindly. Its six-table truncation and legacy-ownership change share one transaction.
  Future destructive changes need separate approval; image rollback cannot restore
  deleted demo records or make legacy password code compatible.
- **Credential rotation:** coordinate DB password update, Secrets Manager update,
  pool/task restarts and smoke tests. Clerk signing-key rotation requires releasing
  its new public PEM; do not introduce a Clerk secret key. Do not claim automatic
  runtime rotation; only RDS master is managed.
- **Terraform lock:** identify the exact environment/key and writer before any
  force-unlock. Never remove someone else's active lock or overwrite remote state.

## Recovery objectives — proposed, untested

Production AZ resilience is not regional disaster recovery. Proposed targets for
review: DB PITR RPO ≤15 minutes and restore RTO ≤60 minutes at demo scale; AZ
failover objective ≤5 minutes. These are **targets**, not measured guarantees.
Confirm latest-restorable time, restore a separately named dedicated Godiffy DB
in an approved drill, restore/verify image metadata/version references, update
secret connections through a reviewed plan and verify ownership/session behavior.

S3 versioning aids recovery, not immutability; explicitly deleted versions are not
recoverable by versioning. There is no off-region/account backup or S3 Object Lock.
Define retention and DR requirements before production approval. Backup restoration
can resurrect tombstoned image metadata whose version was deliberately deleted:
reconcile it instead of claiming RDS and S3 share a transaction.

## Patch and retirement discipline

PostgreSQL 17.9 is explicitly pinned with automatic minor upgrades disabled;
review AWS security/minor releases regularly and schedule tested patch plans.
Rebuild images for dependencies/Bun/CA updates and inspect image scan findings.

Retirement requires exact Godiffy resource/data inventory, state/backups and cost
review, a unique reviewed `final_snapshot_suffix` (the default is deliberately
`review-required`), deletion-protection/`prevent_destroy` changes, and explicit
destructive-action approval. Disable ALB logging before log-bucket retirement.
Keep final/automated DB backups deliberately; retained snapshots still cost money.
Never set bucket `force_destroy=true` or recursively delete state/images to make
Terraform cleanup convenient. Do not delete local state backups without approval.
See [the exact DEV retirement runbook](teardown.md) for the separately approved
Actions teardown slice, nonempty bucket/repository safeguards and CI grants removed last.

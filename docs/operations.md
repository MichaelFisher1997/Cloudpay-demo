# Operating the existing DEV demo

This is reference material, not authorization to deploy or change infrastructure.
Use GitHub Actions from `dev`; `master` is protected for code promotion only.
Production remains an undeployed example/template.

## Routine release

1. Validate the code and review changes.
2. If needed, manually run `dev-image.yml` on `dev`. It publishes only to DEV ECR
   and reports the immutable digest after checking its scan.
3. Update and review `terraform/environments/dev/release.tfvars.json`. Preserve
   exact prior task definitions/digests; see [DEV inputs](../terraform/environments/dev/README.md).
4. Run `dev-deploy.yml` with `operation=plan`. Review resource changes, cost and
   migration impact; stop for unexpected replacement, deletion or IAM changes.
5. If approved, run `operation=apply` with the plan run's commit SHA as
   `reviewed_revision`. Apply generates a fresh saved plan at that revision;
   [delivery](delivery.md) explains the drift/approval limitation.
6. Manually check approved Google sign-in, gallery loading and a disposable image
   upload/download/delete. Review ECS events and application logs if it fails.

Do not run foundations-only inputs against the running service, reactivate
bootstrap privileges, select legacy password images or reset demo data.
The current release input matches the recorded live deployment. Cleanup did not
apply infrastructure or write remote state.

## Database changes

Existing credentials/schema are already initialized. Routine Terraform apply does
not execute SQL. The pipeline no longer runs migrations or private verification
jobs. A future schema change needs a separately reviewed migration task using the
schema-owner role/secret, explicit exit-code verification and backward-compatible
ordering. Never use the runtime/master identity for routine schema migrations.

## Troubleshooting and recovery

- **Task won't start:** ECS stopped reason/events, image digest, execution-role
  permissions, ECR/S3 endpoints and CloudWatch Logs connectivity.
- **ALB unhealthy:** target registration, port 3000, SG rules and process probes.
  A healthy probe does not establish database availability.
- **Database errors:** DB availability, task-to-DB SG rules, runtime secret access,
  verified TLS, pool capacity and SQL grants. Scaling tasks cannot fix an exhausted DB.
- **Image-transfer errors:** ownership authorization, signed URL expiry, bucket
  versioning, CORS and IAM actions; browsers do not use the VPC endpoint.
- **Failed release:** ECS circuit-breaker rollback may restore a healthy task
  revision. Deliberate rollback needs a compatible image and reviewed Terraform
  inputs; legacy password images are not compatible after Clerk migration.
- **Credentials/keys:** coordinate DB secret updates with task restarts. Clerk
  public-key rotation needs a reviewed release. Do not log tokens or signed URLs.
- **State lock:** identify the exact writer before considering force-unlock.

DEV remains HTTP-only; use non-sensitive images. Production TLS/DNS, confirmed
alert delivery, restore/failover/load exercises and measured recovery targets remain
separate work. See [production readiness](production-readiness.md), [costs](costs.md)
and [teardown](teardown.md). No destroy or data cleanup is authorized by this guide.

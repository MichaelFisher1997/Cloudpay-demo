# Interview study guide

Focus on explaining the infrastructure you have, not memorising every support
script. The product is a small named-user image gallery; the assessment is the
Terraform-managed web service, database, S3 access and Well-Architected decisions.

Delivery story: **work/push on `dev` → validation → manual AWS DEV release**.
Code promotion uses **PR from `dev` to protected `master` → checks → owner merge**;
`master` never deploys. The production root demonstrates module reuse only.
The live OIDC trust matches only `dev`, and its identity-only Actions check passed.

## Tonight: follow the dependency path

| Order | Files | What you should be able to explain |
| --- | --- | --- |
| 1 | `terraform/bootstrap/main.tf`, `backend.hcl` | State is separate from the application; encryption, versioning, access controls and native `.tflock` locking. |
| 2 | `terraform/environments/dev/main.tf`, `variables.tf`, `backend.hcl` | Root/provider versus child modules, version pins, account guard, separate environment state and explicit release inputs. |
| 3 | `terraform/modules/godiffy/main.tf` | Composition: module outputs become other modules' inputs; dev/prod differences; implicit dependencies and explicit networking completion. |
| 4 | `terraform/modules/networking/main.tf` | Six subnets, public-only internet route, private AWS endpoints, security-group flows and no NAT. |
| 5 | `terraform/modules/storage/main.tf` | Private, encrypted, versioned S3; exact-origin CORS, TLS-only access and pending-upload lifecycle. |
| 6 | `terraform/modules/database/main.tf` | Isolated encrypted RDS, managed master password, empty app-secret containers, forced TLS, backups and deletion safeguards. |
| 7 | `terraform/modules/application/iam.tf` | Trust versus permissions; execution versus runtime versus migration; least privilege and DEV permission boundaries. |
| 8 | `terraform/modules/application/main.tf` | ECR digest, ALB/IP targets, Fargate task/service, rolling deployments, circuit breaker and autoscaling. |
| 9 | `.github/workflows/validate.yml`, `dev-image.yml`, `dev-deploy.yml` | No-credential validation, OIDC/STS, immutable images, saved reviewed plans and Terraform ownership of releases. |
| 10 | `terraform/modules/godiffy/monitoring.tf`, production root | What alarms/backups/HA achieve—and what needs real operational testing. |

For each section, answer: **what does it do, why is it needed, what depends on it,
what can fail, and what alternative would you choose under different requirements?**

## Key decisions to understand

- **Fargate instead of EC2/Kubernetes:** no host/cluster administration for a small
  stateless container. ALB routes requests; RDS/S3 retain data across replacements.
- **Endpoints instead of NAT:** tasks reach the required AWS services privately,
  but cannot call arbitrary internet APIs. ECR layers also require S3 access.
  Clerk calls originate in the browser; the server verifies JWTs offline.
- **Direct S3 transfers:** application authorizes owners and signs bounded access;
  image bytes do not pass through Fargate. CORS is a browser rule, not authorization.
- **Separate identities:** execution pulls/logs, runtime accesses app data,
  migration owns schema changes. Initialization had temporary master access and is
  now retired. IAM access and PostgreSQL grants are different boundaries.
- **Terraform owns infrastructure and releases:** autoscaling owns desired count,
  so only that attribute uses `ignore_changes`. Images are pinned by digest.
- **Separate dev/prod roots:** same modules, separate state keys and VPCs, not CLI
  workspaces. They currently share an AWS account, not separate account isolation.

## Be explicit about production gaps

DEV is a working demonstration, **not a fully production-ready deployment**.
Public HTTP exposes bearer tokens. Production is undeployed; its configuration
adds TLS guards, two minimum tasks, dual-AZ endpoints, Multi-AZ RDS and retention.
Private ALB-to-task traffic remains HTTP. DEV has permission boundaries; the
production root currently does not pass any. Production identity/approval, DNS,
Clerk setup, alert delivery and restore/failover/load evidence remain outstanding.
Health probes are process-only; backups are not proof of a successful restore.

## Questions to practise in your own words

1. What is in Terraform state, and how do state locking and workflow concurrency differ?
2. Why apply a saved plan? What makes a previously reviewed plan unsafe to reuse?
3. How do private tasks pull ECR images without NAT? What breaks if S3 access disappears?
4. Does a permissions boundary grant access? How does it constrain CI-created roles?
5. Why are execution and task roles different? What does `iam:PassRole` permit?
6. How can browsers access a private S3 bucket without AWS credentials of their own?
7. Why doesn't Terraform contain the database passwords? How would you rotate them?
8. What happens if a task crashes, an AZ fails, or PostgreSQL stops responding?
9. Why ignore desired count but not the task definition? What is your rollback boundary?
10. Which controls support each of the six Well-Architected pillars, and at what cost?

## Supporting material—not the main walkthrough

`ci.tf`, `aws/ci/`, plan auditing and retained task history protect the existing
DEV deployment. Do not claim these are required by every production service.
History remains to avoid changing tracked resources; removing it needs reviewed
state migration. Historical repair/recovery scripts and old password smoke tools
have been removed. Detailed deployment records are in `docs/archive/`.

Use [DEV status](dev-deployment.md) for evidence, [delivery](delivery.md) for the
pipeline, [costs](costs.md) for trade-offs and [production readiness](production-readiness.md)
for launch gates. Local mocks, recorded AWS job results and owner-reported browser
tests are different kinds of evidence—keep them separate.

# Delivery: validation, image, reviewed release

**Develop on `dev` → PR checks → merge to `dev` → manually deploy to existing AWS DEV.**
Work on `dev` is integrated through short-lived feature-branch PRs targeting `dev`.
`master` has no active deployment role. Production is a Terraform example/template,
not a deployed environment or delivery pipeline.

Repository changes are prepared locally. DEV authentication from `dev` remains
blocked until the separately approved [OIDC trust update](aws-oidc.md) is applied.
Publish `dev` and approve it as the GitHub default branch so manual workflows are
discoverable. Require validation and PR review on `dev` to enforce approved merges;
workflow YAML alone does not enforce review or prevent direct pushes.

## 1. Validate without AWS credentials

`.github/workflows/validate.yml` runs on PRs targeting `dev`, pushes to `dev` and
manual dispatch. It checks
Terraform formatting/validation/mock tests, application types/tests/build, local
PostgreSQL integration and a non-root/read-only container smoke. It does not read
remote state, obtain an OIDC token, publish images or deploy infrastructure.

## 2. Build and publish an immutable image

The manually dispatched `dev-image.yml` runs only on `dev`, builds `app/` for linux/amd64, smoke-tests
it and publishes a commit-tagged image to the dedicated DEV ECR repository.
ECR tags are immutable. The workflow records the digest and requires a completed
scan without critical/high findings. Application dependency checks are separate.

## 3. Review and apply a DEV service release

The manually dispatched `dev-deploy.yml` runs only on `dev` and uses an existing
immutable image digest. For the running environment, use `phase=service`.
Merge to `dev` does not automatically build, apply or run a database migration.

1. OIDC assumes the DEV-scoped AWS role; no permanent AWS keys are stored in GitHub.
2. Initialize the DEV S3 backend with native locking.
3. Reconstruct retained task-definition inputs so existing history is not deleted.
4. Save a Terraform plan and audit DEV scope, ownership, no deletions/replacements
   and no CI self-IAM changes. Review its summary and change fingerprint.
5. An explicit apply invocation creates a fresh plan and requires the same reviewed
   fingerprint, then applies that exact runner-local saved plan.
6. Verify private DB access, run the idempotent migration, verify again and check
   anonymous Clerk/API boundaries. Finish with a refreshed no-change plan.

Both delivery workflows share a non-cancelling concurrency group. Terraform's
state lock additionally protects state writers. PostgreSQL advisory locks protect
migrations independently. Raw plans/state are not uploaded as ordinary artifacts.

Terraform owns the ECS task definition and service. Only desired task count is
ignored because autoscaling owns it; there is no competing CLI deployment owner.

## Identity and safety boundaries

- The proposed OIDC trust accepts only this repository's immutable identity on
  `dev`, not `master`, PR or protected-environment subjects. The previously recorded
  live trust is `master`-only; no AWS update or fresh live inspection was performed.
- Human-bootstrapped CI policies and task boundaries constrain DEV authority.
  Actions cannot modify its own grants or restore retired bootstrap privilege.
- Execution pulls images/writes logs; runtime reads its own secret and accesses
  image objects; migration reads only the schema-owner secret.
- Historical repair/optional recovery tooling and the workflow's one-off reset
  input have been removed. Foundations/jobs remain for explaining initial setup,
  not for rerunning against the live environment.
- The old smoke-secret container and retained task definitions remain in Terraform
  for state compatibility, not because Clerk requires them.

Production has no deployment workflow or approved deployment role. It remains an
example/template; any future launch would require a separately scoped identity,
approval path and the gates in [production readiness](production-readiness.md).
Never repoint the DEV workflow.

Google login and authenticated image operations still need manual browser checks;
anonymous smoke tests do not prove them. See [DEV status](dev-deployment.md).
Detailed historical records are [archived](archive/delivery.md), not required study.

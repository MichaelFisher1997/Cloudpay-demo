# Simple DEV delivery

**Work/push on `dev` → validation → manual AWS DEV release.**
Promote code with a PR from `dev` to protected `master`; `master` does not deploy.
Only the owner has listed repository write/admin access. Production is an
undeployed Terraform example/template, with no delivery pipeline.

## Workflows

| Workflow | Purpose |
| --- | --- |
| `validate.yml` | Terraform fmt/init-without-backend/validate/mock tests; app checks and local container tests. Runs on `dev` pushes and PRs targeting `master`, without AWS credentials. |
| `dev-image.yml` | Manually build, test and publish a commit-tagged image to DEV ECR; wait for the scan and reject critical/high findings. |
| `dev-deploy.yml` | Manually initialize DEV state, validate, plan and optionally apply. |
| `aws-oidc-check.yml` | Identity-only check; no deployment. |

## Plan and apply

The deployment workflow uses standard commands:

```sh
terraform init -backend-config=backend.hcl
terraform validate
terraform plan -var-file=release.tfvars.json -out=dev.tfplan
terraform apply dev.tfplan
```

Run `operation=plan`, review the changes and record the commit SHA shown in the
summary. For an approved DEV apply, run `operation=apply` on the same revision and
provide `reviewed_revision`. The job checks that SHA, generates a **fresh** saved
plan and applies that runner-local plan. Plans/state are not published as artifacts.

**Trade-off:** matching the code revision does not prove the fresh plan is identical
to the earlier reviewed plan; remote drift may change it. The custom semantic-hash
framework has been removed. Stronger production delivery would need a secure,
exact reviewed-plan approval mechanism. This is a deliberately simple manual DEV
pipeline, not a production approval guarantee.

`release.tfvars.json` explicitly records the current image, public auth settings
and retained task definitions. Historical data remains to avoid removing existing
tracked records, but no Python script reconstructs it. Future releases must retain
their predecessor's exact configuration; see [DEV inputs](../terraform/environments/dev/README.md).

## What remains separate

- New image publication and release-input changes require review; pushing code
  does not automatically change AWS infrastructure.
- The database is already initialized. Automatic bootstrap, migration and runtime
  verification jobs have been removed from routine deployment. Schema changes
  require a separate reviewed migration; image rollback cannot undo schema changes.
- Google login/gallery/image operations need a manual browser check after release.
- Restore, failover and load testing remain future operational work.

OIDC still trusts only `dev`. The existing DEV role, permission policies,
boundaries, resource names and backend key are unchanged. Terraform owns ECS
configuration; autoscaling owns only desired task count. Image/deployment workflows
share concurrency, and native S3 locking protects state writers.

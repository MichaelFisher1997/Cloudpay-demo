# Approved complete Godiffy retirement — 2026-10-22

The owner approved removing **all dedicated Godiffy AWS resources and data** in
account `218549829565`, London (`eu-west-2`), through GitHub Actions. This is a new
complete-retirement approval, not the limited retention scenario in `teardown.md`.

- Delete the DEV application, database and automated backups; **no final snapshot**.
- Delete all image versions, container images and the dedicated Terraform-state
  bucket, including historical state/lock versions.
- Retire the dedicated task/deployment roles, nine IAM policies and observability
  resources. Application secrets retain their configured seven-day recovery window.
- Preserve shared GitHub OIDC, human SSO, AWS service-linked identities, unrelated
  Portyard infrastructure and local project files/backups.

## Execution boundary

`retire-godiffy.yml` is manual, DEV-branch-only and revision-pinned. A temporary
SSO-bootstrapped runner role uses the existing exact repository/branch OIDC trust
and time-limited, project-scoped retirement permissions. SSO removes **that temporary
runner role last**, after the Actions job, so it cannot revoke its own authority.

`aws/retirement/scope.json` fingerprints the approved 111 DEV and six bootstrap
Terraform resource identities. The job refuses a different inventory, unapproved
plan IDs, creates/updates/replacements, another account, another branch/repository,
or a missing explicit destroy confirmation. Delivery workflows must be disabled
and have no running, queued, waiting or pending runs.

Terraform runs in a private runner-temporary copy: normal source protections and
production configuration remain untouched. The explicitly approved database
deletion runs through AWS CLI in Actions with `--skip-final-snapshot` and
`--delete-automated-backups`. Terraform then refreshes away that missing instance
and retires the remaining application, followed by IAM policies. The bootstrap
state is copied to a private local backend **before** its own S3 bucket is emptied
and destroyed. No raw state, binary plan, credentials or secret values are uploaded
as public logs or ordinary Actions artifacts.

Private state backups were also taken outside the repository before retirement.
If a run partially succeeds, stop and re-inventory; update the approved remaining
state fingerprint only after comparing it to those backups. Never force-unlock,
reset state, broaden permissions, or blindly rerun a mismatched inventory.

After deletion, verify the application/database/networking/storage/IAM absence;
record any Secrets Manager recovery dates or ECS metadata still deleting. An
AWS-managed asynchronous deletion is not proof that its metadata has vanished.

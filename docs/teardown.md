# DEV retirement — separate approval required

**Do not execute this under the deployment approval.** Confirm the exact deployed
inventory in [dev-deployment.md](dev-deployment.md), what image/database data may be
deleted and which snapshots/backups must survive. Application retirement must also
run through an explicitly reviewed Actions job, not the local SSO session.

## Scope that must remain untouched

- Account `218549829565`, region `eu-west-2`; retire only the dedicated `godiffy-dev-*`
  application resources and the explicitly approved images/versions.
- Preserve `godiffy-terraform-state-218549829565-eu-west-2`, bootstrap state, native
  locks, production state and both owner-only local pre-migration/state backups.
- Preserve the existing GitHub OIDC provider, `cloudpay-demo-github-actions` role,
  immutable master-only trust, `portyard` profile and human SSO role.
- Preserve AWS-managed service-linked roles, including the two approved during DEV
  creation: they are account-level service identities, not DEV Terraform resources.
- Never include Portyard resources, production, DNS or certificates.

## 1. Freeze and review

After approval, disable only the three DEV workflows and inspect/cancel any exact
DEV queued/running run before retirement; leave credential-free validation enabled:

```sh
gh workflow disable dev-deploy.yml --repo MichaelFisher1997/Cloudpay-demo
gh workflow disable dev-image.yml --repo MichaelFisher1997/Cloudpay-demo
gh workflow disable dev-verify.yml --repo MichaelFisher1997/Cloudpay-demo
```

Prepare a separately reviewed manual retirement workflow on master. It needs an
explicitly approved, temporary **DEV-only** teardown policy: current CI scopes
deliberately cannot delete infrastructure, policies, buckets or repositories.
Human SSO may bootstrap that exact policy, not grant AdministratorAccess or edit
the existing trust. Remove the temporary grant afterward.

The retirement runner securely backs up the exact DEV state, inventories resource
IDs and records selected backup/image retention. Raw state/credentials must not be
published in logs or ordinary Actions artifacts.

## 2. Review data and protection changes

- Choose a unique `final_snapshot_suffix`, for example `interview-retirement-<UTC>-<short-SHA>`.
  Keep `skip_final_snapshot=false`, `delete_automated_backups=false` and record the
  final snapshot name `godiffy-dev-final-<that-suffix>`.
- In an explicit retirement-only code change, remove `prevent_destroy` from the
  DEV DB instance, image bucket, runtime/migration secret containers and smoke secret; disable DEV DB deletion protection
  with a reviewed non-destructive Actions apply **before** the destroy plan.
  Do not weaken production protections. Do not change final-snapshot requirements.
- Inventory **all versions and delete markers** in
  `godiffy-dev-images-218549829565-eu-west-2`, and all tagged/untagged digests in
  `godiffy-dev-application`. Either retain those resources or obtain explicit
  exact-scope data-deletion approval. `force_destroy` / `force_delete` stay false.
- If deletion is approved, generate and review object-version batches/digest lists
  from those exact resources, then execute `s3api delete-objects` / `ecr batch-delete-image`
  inside the retirement job. Never use broad recursive deletes or target state.
  Re-list versions/delete markers/images to prove emptiness before resource deletion.
- Secret deletion uses its configured recovery window; do not use force-without-recovery.

## 3. Destroy application resources, not the active CI grants

Use `terraform/environments/dev/backend.hcl`, workspace `default`, and the actual
release inputs/digests from the final handoff. **Do not destroy the whole DEV root
while relying on its CI policy attachments**: detaching them prematurely can remove
the running job's authority. The exceptional, explicit retirement slice is:

```sh
terraform -chdir=terraform/environments/dev init -input=false -lockfile=readonly -backend-config=backend.hcl
terraform -chdir=terraform/environments/dev plan -destroy -input=false -no-color \
  -var-file=approved-retirement.local.tfvars.json \
  -target=module.godiffy -target=aws_secretsmanager_secret.smoke -out=dev-retirement.tfplan
terraform -chdir=terraform/environments/dev show -no-color dev-retirement.tfplan
```

This is a reviewed retirement exception, **not** routine targeted deployment. Verify
the saved plan contains only the approved application slice and no backend, CI
policy/provider/role, production or unrelated deletions. The normal deployment
auditor rejects every deletion and must not be bypassed for regular releases;
retirement needs its own explicit destructive-plan review/approval. Apply only
that reviewed plan in Actions. Retained nonempty buckets/ECR must be deliberately
excluded or migrated to an approved retained-resource configuration, never forced away.

## 4. Retire the CI grants last and verify retained costs

After application retirement, separately review removal of the five
`godiffy-dev-ci-{network,data,services,control,iam}` attachments from the reused OIDC
role and deletion of the nine dedicated policies (five CI scopes/four boundaries), once no task role
uses a boundary. This needs removal of their DEV `prevent_destroy` protection and
an approved IAM retirement step/identity that does not revoke itself mid-operation.
The original role/provider/trust remain identity-only afterward. Remove the temporary
teardown grant last. Reconcile DEV state with the deliberately retained inventory.

Verify the final DB snapshot and retained automated backups actually exist, record
their IDs and recurring storage charges, and account for any retained S3/ECR/secret
recovery resources. Keep the approved backend and local backups. Do not claim an
empty account/state while deliberately retained snapshots or policies remain.

# Godiffy Terraform state

## Scope

This stage provisions only the dedicated Godiffy Terraform state bucket:

- Account: `218549829565`
- Region: `eu-west-2`
- Bucket: `godiffy-terraform-state-218549829565-eu-west-2`
- Root module: `terraform/bootstrap/`

The bucket is bootstrap infrastructure, outside the development/production
application lifecycles. No existing application resources are reused or imported.
No IAM users, identity policies, roles, OIDC providers, DynamoDB tables, or
customer-managed KMS keys are created or changed by this root.

The AWS profile `portyard` is used only for the existing human SSO identity.
It is not a reference to, or permission to manage, another project's resources.

## Protection and cost

Terraform manages one bucket and five separate bucket configurations:

| Resource | Reason |
| --- | --- |
| S3 bucket | Dedicated storage; `force_destroy = false` and `prevent_destroy = true` |
| Ownership controls | Bucket Owner Enforced; ACLs disabled |
| Block Public Access | All four controls enabled |
| Default encryption | SSE-S3 (`AES256`); customer-provided keys remain blocked |
| Versioning | Previous state revisions retained for recovery |
| Bucket policy | Deny HTTP access to this bucket and its objects |

The TLS deny excludes AWS service principals as AWS recommends for redacted
service-to-service network context. It grants no access. SSO permissions currently
authorise the human; GitHub's existing OIDC role still has no backend permissions.
Scoped CI state/lock permissions will be designed in a later approved stage.

No state or lock expiry rules are configured. S3 Object Lock (WORM retention) is
not Terraform's state-locking mechanism and is not enabled.

There is no fixed hourly bucket charge. Small state files and normal request
volumes should cost substantially less than $1/month, excluding exceptional
usage. Retained versions consume storage. SSE-S3 avoids customer-managed KMS key
and KMS request charges.

`prevent_destroy` is a Terraform guardrail, not immutability: removing the resource
configuration or acting outside Terraform can bypass it. Backend cleanup requires
a separate reviewed plan and explicit destructive-action approval.

## Versions and local tools

- Terraform CLI: `1.16.5`, pinned in `.terraform-version` and `shell.nix`.
- Supported Terraform CLI series: `~> 1.16.0`.
- AWS provider: `6.67.0`, pinned in the root and `.terraform.lock.hcl`.

The Nix shell downloads the official Terraform Linux x86-64 binary using its
published SHA-256 checksum. The existing AWS CLI setup is unchanged.

This small bootstrap root has no configurable deployment-target variables:
account, region, name, and state keys are explicit locals. That is intentional;
changing the destination requires a reviewed code change rather than an accidental
CLI override. There is no reusable module wrapper for this single bucket.

Run from the repository root:

```sh
nix-shell
umask 077
export AWS_PROFILE=portyard
export AWS_REGION=eu-west-2
export AWS_PAGER=""
terraform version
aws sts get-caller-identity --region eu-west-2
```

Continue only if the account is `218549829565`. If the existing SSO session has
expired, renew it using `aws sso login --profile portyard`; do not create keys or
replace the SSO configuration. No credentials belong in Terraform/backend files.

## State layout and locking

| Root | S3 object key | Backend configuration |
| --- | --- | --- |
| Bootstrap | `godiffy/bootstrap/terraform.tfstate` | `terraform/bootstrap/backend.hcl` |
| Development | `godiffy/dev/terraform.tfstate` | `terraform/environments/dev/backend.hcl` |
| Production | `godiffy/prod/terraform.tfstate` | `terraform/environments/prod/backend.hcl` |

Every backend uses `encrypt = true`, `use_lockfile = true`, and an account allow
list. Its lock object is the state key followed by `.tflock`.

S3-native state locking is supported from Terraform 1.10. DynamoDB locking is
deprecated and no DynamoDB lock table is needed. Locking prevents concurrent
Terraform writers; it does not authorise apply or prevent manual AWS changes.

The environment backend files do not provision application resources. Subsequent
environment init/plan operations may initialize empty state objects and write their
own lockfiles; no development/production AWS application resources were applied.
Separate keys are not an IAM boundary by themselves: future CI policies must
restrict access to each required state and lock path.

## Current use: remote state

The checked-in `backend.tf` is now active. For normal use, initialize the **remote**
backend, never start again with a fresh local state:

```sh
terraform -chdir=terraform/bootstrap init -backend-config=backend.hcl
terraform -chdir=terraform/bootstrap state list
terraform -chdir=terraform/bootstrap plan -detailed-exitcode
```

All six bucket/configuration resources are tracked; the verified remote plan is
empty. Remote state HEAD confirmed SSE-S3 and a non-null version ID. Historical
`.tflock` versions and a latest deletion marker confirmed lock creation/release.
There is no current bootstrap lock. Local backups remain owner-only and ignored.

## Initial bootstrap record: local state

The bucket must exist before it can store its own Terraform state. During the
initial stage, an inactive `backend.tf.example` allowed Terraform to use local
state. That example was later activated/renamed as `backend.tf`; the commands below
describe the initial stage, **not the way to initialize today's checkout**.

From the repository root, inside the Nix shell:

```sh
terraform -chdir=terraform/bootstrap init
terraform fmt -check -recursive terraform
terraform -chdir=terraform/bootstrap validate
terraform -chdir=terraform/bootstrap test
terraform -chdir=terraform/bootstrap plan -out=bootstrap.tfplan
terraform -chdir=terraform/bootstrap show -no-color bootstrap.tfplan
```

The tests use a mocked AWS provider and plan-only runs. They do not contact AWS or
create/destroy real resources. The real plan should show six additions, zero
changes, and zero deletions, all targeting the one Godiffy bucket.

**Stop for explicit approval of that saved plan before applying.** After approval:

```sh
terraform -chdir=terraform/bootstrap apply bootstrap.tfplan
```

Local state, backups, working directories, and binary plans are ignored by Git.
Set `umask 077` inside the Nix shell so new local artifacts are owner-only.
Keep them on trusted storage; `sensitive = true` is not state encryption. Do not
publish raw state, binary plans, or JSON plan dumps in public artifacts/logs.

## Verification and migration to S3

Verify the exact bucket's location, tags, ownership controls, public-access block,
encryption, versioning, and TLS policy before writing remote state. Do not inspect
or alter unrelated buckets. AWS recommends allowing 15 minutes after initially
enabling bucket versioning before object writes; preserve local state meanwhile.

For a fresh bootstrap, after verification and the propagation wait, activate the
S3 backend and explicitly migrate the existing local state:

```sh
terraform -chdir=terraform/bootstrap init -migrate-state -backend-config=backend.hcl
```

Review and confirm Terraform's copy prompt. Do not use `-reconfigure` instead of
migration, do not overwrite an existing remote state, and do not use `-force-copy`
to bypass that prompt.

Then verify:

```sh
terraform -chdir=terraform/bootstrap state list
terraform -chdir=terraform/bootstrap plan -detailed-exitcode
```

The list should contain the same six resources; the plan should be empty (exit
code `0`). Check the bootstrap state object has SSE-S3 encryption and a non-null
version ID. A normal remote plan should create/release its `.tflock`; no current
lock should remain after it finishes. Keep local backups until remote state and
locking are verified; any deletion of those files requires separate approval.

### Actual migration recovery record

The approved bootstrap applied six additions with no changes/deletions. Direct
AWS CLI verification suffered timeouts; a fresh provider refresh/empty plan
independently verified all bucket protections. Before migration, an additional
owner-only `terraform.tfstate.pre-migration.backup` preserved the six records.

The first automated copy confirmation was conservatively declined because its
multiline safety check did not match the prompt. Terraform initialized the new
backend empty and preserved its own local backup. No pre-existing remote resource
state was overwritten. After verifying the remote state contained zero resources,
the approved state was recovered into that backend using `state push` **without
`-force`**, with normal native locking.

That empty backend assigned a new lineage/serial; it did not preserve the original
local lineage. All six resource records and outputs were compared against the
preserved backup and matched exactly. A refreshed remote plan was empty, followed
by the encryption/version/lock checks above. Use current remote-state versions for
future recovery rather than blindly pushing the older local lineage. Local backups
and saved plans were not deleted or published.

## Future backend IAM

Use exact Godiffy resources, not blanket S3 access:

- Bucket listing scoped to the required Godiffy prefix.
- `s3:GetObject` and `s3:PutObject` on the exact state object.
- `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on its exact `.tflock`.
- No routine `s3:DeleteObject` grant on the state itself.

State can contain sensitive values, so restrict read access as well as writes.
This stage does not attach permissions to `cloudpay-demo-github-actions`.

## Application integration remains later

Initial development uses the ALB hostname over HTTP with disposable demo data.
ACM certificates and manual Cloudflare DNS validation are not dependencies of
this backend or the initial application build. Custom domains, HTTPS, and redirects
remain the final integration stage. Cloudflare remains outside Terraform initially.

## References

- [Terraform S3 backend and locking](https://developer.hashicorp.com/terraform/language/backend/s3)
- [Terraform backend migration](https://developer.hashicorp.com/terraform/cli/commands/init#backend-initialization)
- [AWS bucket policy transport conditions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/amazon-s3-policy-keys.html#example-object-tls-version)
- [S3 versioning propagation guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/manage-versioning-examples.html)

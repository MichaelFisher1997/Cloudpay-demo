# GitHub OIDC: proposed DEV branch switch

**Status:** workflows now target `dev` locally. No live AWS trust, GitHub setting,
remote branch or infrastructure change has been made. The previously recorded
trust permits `master` only; it has not been freshly inspected in AWS.

## Exact trust change requiring approval

Target the existing role `arn:aws:iam::218549829565:role/cloudpay-demo-github-actions`.
Replace just the exact subject condition:

```diff
- repo:MichaelFisher1997@91565606/Cloudpay-demo@1407927569:ref:refs/heads/master
+ repo:MichaelFisher1997@91565606/Cloudpay-demo@1407927569:ref:refs/heads/dev
```

[`aws/github-actions-trust-policy.json`](../aws/github-actions-trust-policy.json)
contains the complete proposed policy. `Sid` changes to `GitHubActionsDevOnly`
for clarity; it grants no additional authority.

Keep everything else unchanged:

- Existing federated provider:
  `arn:aws:iam::218549829565:oidc-provider/token.actions.githubusercontent.com`.
- Action: `sts:AssumeRoleWithWebIdentity`.
- Exact `StringEquals` audience: `sts.amazonaws.com`.
- Exact immutable owner/repository IDs and branch subject; no wildcards, branch
  list, PR/tag/environment subjects or temporary dual-branch trust.
- Existing DEV-only permissions, boundaries, role/session settings, resources
  and Terraform backend keys. No production permission grant.

This replaces which branch may obtain the existing DEV permissions; it does not
broaden those permissions. After approval/application, `master` no longer matches.
`dev` cannot authenticate until the live change is applied. Editing JSON alone
does not update AWS, and Terraform does not manage this existing OIDC trust.

The immutable subject format comes from the recorded repository configuration.
Before applying, separately approve read-only inspection of the live trust and
GitHub OIDC configuration; confirm they still match and preserve unrelated trust
statements if any. Never print tokens or credentials.

## GitHub setup requiring separate approval

1. Commit the reviewed cleanup/branch changes and publish `dev` (not done here).
2. Make `dev` the repository's default branch. Manual `workflow_dispatch` workflows
   must exist on the default branch to be dispatchable; selecting `--ref dev`
   does not remove that requirement. Keep `master`, but exclude it from active delivery.
3. Protect `dev`: require PR review and the `validate` status check, restrict direct
   pushes/bypass where supported. Confirm the actual check name after the first run.
   YAML triggers do not enforce approvals. No GitHub Environment is added because
   it would change the OIDC subject and fail this exact branch trust.
4. Apply only the reviewed AWS trust substitution above, then approve a read-only
   identity check before any image publication or deployment.

The old OIDC bootstrap guide described an authentication-only role. Later setup
attached narrowly scoped DEV CI policies; this is now the DEV deployment role,
not a permissionless identity-test role. Its permissions are unchanged here.

## Existing identity-check workflow

`aws-oidc-check.yml` permits only this repository on `dev`, manually or on pushes
to `dev` changing that file. It requests `id-token: write`, a 900-second session,
and runs `sts get-caller-identity`, not Terraform or a deployment. Image publication
uses 900 seconds; DEV deployment uses 3600 seconds. No permanent AWS keys are used.

After the above approvals, the identity check can be dispatched with:

```sh
gh workflow run aws-oidc-check.yml --ref dev --repo MichaelFisher1997/Cloudpay-demo
```

Expected account: `218549829565`; expected assumed role:
`cloudpay-demo-github-actions`. An identity check is not proof of permission to
deploy or of application health. See [delivery](delivery.md) for reviewed releases.

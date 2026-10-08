# GitHub OIDC: DEV-only branch trust

**Status:** `dev` is published and is GitHub's default branch. The live AWS trust
was inspected, changed with explicit approval and verified to match only `dev`.
The [identity-only Actions check](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37832504315)
passed. No image publication, Terraform apply or application deployment was run.

## Exact approved trust change

Target the existing role `arn:aws:iam::218549829565:role/cloudpay-demo-github-actions`.
The exact subject condition was replaced:

```diff
- repo:MichaelFisher1997@91565606/Cloudpay-demo@1407927569:ref:refs/heads/master
+ repo:MichaelFisher1997@91565606/Cloudpay-demo@1407927569:ref:refs/heads/dev
```

[`aws/github-actions-trust-policy.json`](../aws/github-actions-trust-policy.json)
contains the complete applied policy. `Sid` changed to `GitHubActionsDevOnly`
for clarity; it grants no additional authority.

Everything else remained unchanged:

- Existing federated provider:
  `arn:aws:iam::218549829565:oidc-provider/token.actions.githubusercontent.com`.
- Action: `sts:AssumeRoleWithWebIdentity`.
- Exact `StringEquals` audience: `sts.amazonaws.com`.
- Exact immutable owner/repository IDs and branch subject; no wildcards, branch
  list, PR/tag/environment subjects or temporary dual-branch trust.
- Existing DEV-only permissions, boundaries, role/session settings, resources
  and Terraform backend keys. No production permission grant.

This replaces which branch may obtain the existing DEV permissions; it does not
broaden those permissions. `master` no longer matches; `dev` authentication passed.
Future edits to JSON alone
does not update AWS, and Terraform does not manage this existing OIDC trust.

The immutable subject format was confirmed using GitHub's repository OIDC
configuration. Live inspection found one exact master-only trust statement before
the update. Future trust changes require explicit review and approval; preserve
unrelated statements if any. Never print tokens or credentials.

## GitHub branching and access

1. Work and push directly to `dev`; no PR or separate feature branch is required.
2. `dev` is the repository's default branch. Manual `workflow_dispatch` workflows
   must exist on the default branch to be dispatchable; selecting `--ref dev`
   does not remove that requirement. Keep `master`, but exclude it from active delivery.
3. Protection belongs to `master`, not `dev`. Promote code with a PR from `dev`
   to `master`; `validate` must pass and be current with the base branch. Admins
   are included, force pushes/deletion are blocked and conversations must be resolved.
   The owner decides when to merge; no third-party approval is required for this
   solo repository. Only `MichaelFisher1997` has listed write/admin access; there
   are no pending collaborator invitations or deploy keys.
   No GitHub Environment is added because
   it would change the OIDC subject and fail this exact branch trust.
4. The exact trust substitution above was applied and verified through an identity-only
   check. Image publication and deployments remain separate manual operations.

The old OIDC bootstrap guide described an authentication-only role. Later setup
attached narrowly scoped DEV CI policies; this is now the DEV deployment role,
not a permissionless identity-test role. Its permissions are unchanged here.

## Existing identity-check workflow

`aws-oidc-check.yml` permits only this repository on `dev`, manually or on pushes
to `dev` changing that file. It requests `id-token: write`, a 900-second session,
and runs `sts get-caller-identity`, not Terraform or a deployment. Image publication
uses 900 seconds; DEV deployment uses 3600 seconds. No permanent AWS keys are used.

The identity check can be dispatched with:

```sh
gh workflow run aws-oidc-check.yml --ref dev --repo MichaelFisher1997/Cloudpay-demo
```

Expected account: `218549829565`; expected assumed role:
`cloudpay-demo-github-actions`. An identity check is not proof of permission to
deploy or of application health. See [delivery](delivery.md) for reviewed releases.

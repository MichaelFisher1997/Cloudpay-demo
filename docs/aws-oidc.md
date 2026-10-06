# GitHub Actions AWS OIDC bootstrap

This setup authenticates `MichaelFisher1997/Cloudpay-demo` to AWS using GitHub
OpenID Connect and temporary role credentials. It does not provision application
infrastructure or grant infrastructure deployment permissions.

## Resources and scope

| Setting | Value |
| --- | --- |
| AWS account | `218549829565` |
| Project region | `eu-west-2` |
| OIDC provider URL | `https://token.actions.githubusercontent.com` |
| OIDC audience | `sts.amazonaws.com` |
| IAM role | `cloudpay-demo-github-actions` |
| Role ARN | `arn:aws:iam::218549829565:role/cloudpay-demo-github-actions` |
| Trusted branch | `master` only |
| Workflow session duration | 900 seconds (15 minutes) |
| Role maximum session duration | 3600 seconds (IAM's minimum configurable maximum) |

IAM roles and OIDC providers are global resources. The workflow uses `eu-west-2`
for AWS credential configuration and its STS identity check.

The provider identifies GitHub's token issuer but grants no access by itself.
The dedicated role's trust policy is recorded in
[`aws/github-actions-trust-policy.json`](../aws/github-actions-trust-policy.json).
It permits only `sts:AssumeRoleWithWebIdentity`, with exact audience and subject
matches. There are no repository or branch wildcards.

GitHub reports `use_immutable_subject: true` for this repository. Its subject is:

```text
repo:MichaelFisher1997@91565606/Cloudpay-demo@1407927569:ref:refs/heads/master
```

The owner and repository IDs bind trust to this repository's identity, not merely
a potentially reused name. Other repositories, branches, tags, pull-request
subjects, and environment subjects cannot assume the role. A rename, transfer,
default-branch change, or OIDC subject customization requires a deliberate review
of the trust policy and workflow; do not replace these checks with broad wildcards.

The role has no attached managed policies and no inline permissions policies.
AWS STS `GetCallerIdentity` does not require a permission grant, so successful
authentication can be demonstrated without deployment or general read-only access.
No IAM users, long-lived access keys, or GitHub AWS credential secrets are needed.
The role is not used to deploy infrastructure.

## Workflow

[`aws-oidc-check.yml`](../.github/workflows/aws-oidc-check.yml) runs manually on
`master` and on pushes to `master` that change that workflow file.

The job grants only `id-token: write`; all other GitHub token permissions are
disabled. No checkout is necessary. The official AWS credentials action is pinned
to the commit for `v6.3.0`, uses GitHub OIDC, requests a 15-minute session, and
checks that the resulting credentials belong to the expected AWS account.
The following step runs:

```sh
aws sts get-caller-identity --region eu-west-2 --output json --no-cli-pager
```

The result should show account `218549829565` and an ARN beginning with:

```text
arn:aws:sts::218549829565:assumed-role/cloudpay-demo-github-actions/cloudpay-oidc-
```

Caller identity contains identifiers, not credential secrets. Do not add logging
of OIDC tokens or AWS credentials.

To run the check again:

```sh
gh workflow run aws-oidc-check.yml --ref master --repo MichaelFisher1997/Cloudpay-demo
gh run list --workflow aws-oidc-check.yml --repo MichaelFisher1997/Cloudpay-demo
```

The initial AWS resources are bootstrapped locally using an existing IAM Identity
Center session, not by this workflow. The trust-policy JSON is an audit record;
editing it alone does not update the live IAM role. Any future deployment
permissions must be separately reviewed and scoped to this project. Existing
shared identity providers and unrelated account resources must not be modified
as part of this authentication check.

# DEV deployment status

This is a summary of recorded deployment evidence, not a fresh AWS inspection.

The intended active branch is now `dev`; deployments remain manual Actions releases
to the same AWS DEV environment. The branch switch changes no resource or state key.
Authentication from `dev` awaits the approved [OIDC trust change](aws-oidc.md).
Production stays an undeployed Terraform example/template, with no pipeline.

## Working demonstration

- Region: `eu-west-2`.
- URL: http://godiffy-dev-alb-1345285825.eu-west-2.elb.amazonaws.com
- Public two-AZ ALB; one private Fargate task, 0.25 vCPU / 512 MiB.
- Private Single-AZ PostgreSQL 17.9, `db.t4g.micro`, encrypted, seven-day backups.
- Private, encrypted, versioned S3 image bucket.
- Four interface endpoints in one AZ and an S3 gateway endpoint; no NAT.
- Clerk Google sign-in, verified-email allowlist and offline server verification.

Recorded running image:
`sha256:0b9490fbfef66443dbca66960709e4a7c2510890b50396423fcaf369915843d1`.

The [Clerk release](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37700319765)
completed the service rollout, approved one-off data reset, migration and private
database verification, then reported a no-change Terraform plan. Anonymous auth
boundary checks passed. The owner reported successful Google login and image
upload/download/delete, plus rejection of an unapproved account; that proof is manual.

## Honest limitations

- DEV uses public HTTP: gallery bearer tokens are not protected on that connection.
  Use non-sensitive demo images only.
- DEV is not AZ-resilient: one task placement, one endpoint AZ and Single-AZ RDS.
- Health probes check the process, not database connectivity.
- No confirmed alert recipient, restore/failover/load or task-recovery proof is claimed.
- Production, custom domains and HTTPS are not deployed.
- Estimated DEV cost: $100–170/month, not a measured bill or a spending cap.

## Preserve the working deployment

Terraform configuration and resource addresses are unchanged by the repository
cleanup. The release-history helper, retired bootstrap role, IAM boundaries and
legacy smoke-secret container remain because existing state tracks them.
Removing those safely would require a separate reviewed migration/retirement.

Use only reviewed `service` releases against the running DEV environment; do not
rerun foundations/jobs or reactivate bootstrap. The workflow no longer exposes
historical repair or data-reset inputs.

See [delivery](delivery.md), [Clerk access](clerk-dev.md), [costs](costs.md) and
[archived deployment evidence](archive/dev-deployment.md) when needed.

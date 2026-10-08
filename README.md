# Godiffy — CloudPay Terraform assessment

A small image gallery demonstrating the assessment: **an AWS web service with a
PostgreSQL backend and access to a private S3 bucket**, managed with Terraform.
The infrastructure is the focus; the application proves the components work together.

## Architecture

```text
Browser → public ALB → private ECS Fargate → isolated RDS PostgreSQL
                         ├── Secrets Manager (runtime DB credentials)
                         └── private S3 (authorize and sign image access)
Browser ↔ S3 over HTTPS using short-lived presigned requests
```

London (`eu-west-2`), two-AZ VPC, separate public/application/database subnets.
AWS endpoints replace NAT. Clerk Google authentication runs in the browser;
the server verifies tokens offline and checks ownership and verified-email access.

## Start here for the interview

1. [Study guide](docs/interview.md): file order, key decisions and practice questions.
2. [Architecture](docs/architecture.md): networking, security and Well-Architected trade-offs.
3. [Delivery](docs/delivery.md): validation → immutable image → reviewed Terraform release.
4. [Production readiness](docs/production-readiness.md): what is defined versus unfinished.

## Development and deployment workflow

**Develop on `dev` → PR checks → merge to `dev` → deploy to AWS DEV.**

- `dev` is the active development/integration branch. Use short-lived feature
  branches for PRs targeting `dev`; validation also runs on pushes to `dev`.
- After review and merge, manually run the image workflow on `dev`, then the DEV
  deployment workflow: reviewed `service` plan followed by an explicit apply.
  Merging does not automatically change AWS infrastructure.
- `master` is not part of the active workflow. The branch name does not select
  a Terraform environment: deployment still uses `terraform/environments/dev/`
  and the existing DEV state key, role and resource names.
- `terraform/environments/prod/` is an undeployed example/template of module reuse;
  there is no production pipeline.

**Activation pending:** these are local changes. Publishing `dev`, making it the
GitHub default branch with required PR checks/review, and replacing the role's
exact OIDC branch subject require separate approval. The trust-policy JSON is a
proposal, not an applied AWS change. See [OIDC approval details](docs/aws-oidc.md).

```text
terraform/bootstrap/               Protected S3 state backend and native locking
terraform/environments/dev/        Deployed demo root and separate state key
terraform/environments/prod/       Production example/template; no deployment pipeline
terraform/modules/godiffy/         Composition, environment settings and alarms
terraform/modules/networking/      VPC, subnets, routes, security groups and endpoints
terraform/modules/storage/         Private versioned images; production ALB logs
terraform/modules/database/        RDS, backups and secret containers
terraform/modules/application/     ECR, ALB, ECS, task IAM and autoscaling
.github/workflows/                 Validation, OIDC check and manual DEV delivery
app/                              Small containerised gallery
```

## Deployment status and trade-offs

**DEV runs:** http://godiffy-dev-alb-1345285825.eu-west-2.elb.amazonaws.com

- One task, Single-AZ RDS and one endpoint AZ deliberately reduce demo cost.
- **HTTP-only DEV is not production-ready.** Gallery bearer tokens cross HTTP;
  use non-sensitive images. Custom domains and HTTPS are outstanding.
- Production is **not deployed**. Its configuration adds two minimum tasks,
  dual-AZ endpoints, Multi-AZ RDS, longer retention and TLS activation guards.
- ALB-to-task traffic remains HTTP in both designs. Restore/failover/load testing
  and confirmed alert delivery are not claimed.
- DEV cost estimate: **$100–170/month**, not a measured bill or hard cap.

See [DEV evidence](docs/dev-deployment.md), [costs](docs/costs.md) and
[Clerk access](docs/clerk-dev.md). Historical delivery records are in `docs/archive/`;
they are not required study. Existing task-history/state compatibility controls
remain; cleanup has not changed Terraform resources, AWS infrastructure or IAM.

## Local checks

Terraform 1.16.5, AWS provider 6.67.0, Bun 1.4.2, Python 3 and Docker.
The Nix shell supplies Terraform, actionlint and ShellCheck.

```sh
nix-shell
bash scripts/verify.sh
cd app
bun run test:built
```

These use mock AWS/local PostgreSQL, not deployment credentials. Dependency/provider
installation may need internet access. Plans, state, backups and secrets must never
be committed. Deployments require explicit review; [operations](docs/operations.md)
and [teardown](docs/teardown.md) are reference runbooks, not authorization.

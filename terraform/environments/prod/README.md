# Undeployed production skeleton

This root shows how DEV's shared modules could be reused with
`environment = "prod"`. There are no release inputs or production workflows.
Module defaults leave the ECS service and database jobs disabled.

The shared modules still describe production differences such as Multi-AZ RDS,
two endpoint AZs and ALB logging. Their activation guards and mock tests remain.

**Do not apply this example.** Disabled application service does not mean an empty
plan: applying it could create billable foundation resources. The backend file
reserves a separate production state path; it is not evidence of deployment.

A real production implementation would require separately reviewed release,
TLS/DNS, authentication, deployment identity, task permission boundaries,
database initialization and operational readiness work. See
[production considerations](../../../docs/production-readiness.md).

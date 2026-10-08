# Existing Godiffy DEV environment

The root uses the reusable `godiffy` module and the existing DEV backend key.
The deployment workflow passes **`-var-file=release.tfvars.json`** explicitly.
Do not use the empty, foundations-only variable defaults against the live service.

`release.tfvars.json` records the currently deployed image and public Clerk
configuration. Its history fields preserve three releases and ten task-definition
records already tracked in state. It contains public keys, resource identifiers
and container configuration—not secret values or raw Terraform state.

This replaces automatic history reconstruction with ordinary, explicit Terraform
inputs. It is compatibility data, not another infrastructure module to present.

For a future image release, publish/scan the image separately, then update
`release.image_digest` in the reviewed input file. Keep all existing retained
digests and exact historical container definitions. Before a subsequent release,
record the newly deployed definition under `retained_web_containers` and retain
its digest too. Do not change an existing digest's definition to change auth/config;
build a new image and register a new release instead.

The pipeline no longer initializes the DB or runs migrations. Current schema and
credentials already exist. Any future schema change needs an explicitly reviewed,
backward-compatible migration step using the migration identity before promotion.

The default Terraform workspace, names, networking, IAM and state addresses are
unchanged. No state migration, apply or AWS deployment was performed for cleanup.

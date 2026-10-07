#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
umask 077
export TF_IN_AUTOMATION=true
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$PWD/.terraform-provider-cache}"
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
unset AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME
unset AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
unset AWS_CONTAINER_AUTHORIZATION_TOKEN AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
mkdir -p "$TF_PLUGIN_CACHE_DIR"

terraform fmt -check -recursive terraform
for directory in \
  terraform/bootstrap \
  terraform/modules/networking \
  terraform/modules/storage \
  terraform/modules/database \
  terraform/modules/application \
  terraform/modules/godiffy \
  terraform/environments/dev \
  terraform/environments/prod; do
  # Isolate metadata from an operator's cached S3 backend, even in an initialized checkout.
  export TF_DATA_DIR="$PWD/.terraform-validation/${directory//\//-}"
  mkdir -p "$TF_DATA_DIR"
  # No backend/authentication is needed: all tests exclusively use mock providers.
  terraform -chdir="$directory" init -backend=false -input=false -lockfile=readonly -no-color
  terraform -chdir="$directory" validate -no-color
  terraform -chdir="$directory" test -no-color
done

python3 -m unittest discover -s scripts/tests -v
cd app
bun install --frozen-lockfile
bun run format:check
bun run typecheck
bun node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target esnext --module preserve --moduleResolution bundler --resolveJsonModule --types bun ../scripts/test-database.ts ../scripts/smoke-image.ts
bun node_modules/.bin/prettier --check ../scripts/test-database.ts ../scripts/smoke-image.ts
bun run test
bun run build

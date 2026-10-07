# Godiffy — application

Single-container TanStack Start + Bun, PostgreSQL sessions, private versioned S3 images.
DEV deployment is authorized and running through GitHub Actions; the exact tested
URL, digest and verification limits are recorded in [deployment status](../docs/dev-deployment.md).
Production registration and deployment remain blocked pending separate approval.

## Commands

```sh
bun install --frozen-lockfile
bun run format:check
bun run test
bun run typecheck
bun run build
bun run start
# Dedicated one-off IAM roles, ordered:
bun run db:bootstrap
bun run db:migrate
# From app/:
docker build --platform linux/amd64 -t godiffy:local .
```

`GET /health/live` and `/health/ready` are process-only 200 probes, deliberately independent of PostgreSQL. Container binds `0.0.0.0:3000`; Docker CMD runs config preflight then `exec`s Bun so Bun receives SIGTERM. Runtime user is `10001:10001`; the image runs with a read-only filesystem. The multiarch `oven/bun:1.4.2-alpine` base is pinned to OCI index `sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f`; deployment must select linux/amd64. The earlier Debian base had six critical and 19 high OS-package findings; the Alpine replacement retains the same Bun version, and publication/deployment now require a complete ECR scan with no critical/high findings. This OS scan does not cover every statically linked library or prove absence of vulnerabilities. For local PG17 integration tests, run `bun scripts/test-database.ts` from the repository root, which creates a unique temporary `postgres:17-alpine` Docker container, ephemeral password, and host-only random port; it runs `PG_TEST_URL=postgres://... bun test tests/integration.test.ts` inside `app/` without printing credentials. From `app/`, `bun run test:built` first builds then uses that same isolated local runner to exercise the **actual `.output` server** over HTTP: signup, login, session, gallery DB query, blocked outsider and CSRF. The test intentionally sets `NODE_ENV=development`, `ENVIRONMENT=dev`, and loopback `DATABASE_URL`; it does **not** test production AWS/RDS TLS. The integration test has no AWS calls (in-memory Secrets Manager port and S3 port); without `PG_TEST_URL` it skips. Stop only your own named test container.

## Environment / operator contract

The Docker base additionally pins Alpine's published security fixes
`libcrypto3/libssl3=3.5.9-r0` and `zlib=1.3.2-r1` in a shared build/runtime base.
An unpatched Alpine candidate was also rejected (2 critical/8 high findings).
Runtime still performs no package installs and keeps the non-root/read-only contract.

Runtime: **required** `ENVIRONMENT=dev|prod`, `AWS_REGION`, `IMAGE_BUCKET`, `DATABASE_HOST`, `DATABASE_SECRET_ARN`, `APP_URL` (exact public origin). Defaults: `DATABASE_PORT=5432`, `DATABASE_NAME=godiffy`, `INVITED_EMAILS=` (empty disables registration). `APP_URL` must be HTTPS in `prod`, and `ALLOW_INSECURE_HTTP=true` is rejected outright in `prod` even if the URL is HTTPS. HTTP is allowed **only** with both `ENVIRONMENT=dev` and `ALLOW_INSECURE_HTTP=true`; this dev ALB-origin bootstrap is a draft decision. `NODE_ENV=production` remains the build/runtime framework setting; it does not override `ENVIRONMENT`. `DATABASE_URL` is local-only (localhost and `ENVIRONMENT=dev`, rejected with `NODE_ENV=production`); local auth additionally requires ephemeral `LOCAL_AUTH_SECRET` >=32 characters. Runtime secret JSON `{username,password,auth_secret}` is fetched by standard AWS task credentials on first DB use; pool max 5. An idle pool failure emits only a generic log line, never a pg error object. The public RDS global CA bundle is fetched at **image build**, baked into the image, and used for TLS certificate and hostname verification. Rebuild for CA refresh. Credentials are cached per process; after manual rotation restart tasks/job pools. **No automatic rotation is claimed.**

One-off `db:bootstrap`: `AWS_REGION`, `DATABASE_HOST`, optional DB port/name, `MASTER_SECRET_ARN`, `DATABASE_SECRET_ARN`, `MIGRATION_SECRET_ARN`. It reads RDS-managed master JSON username/password, creates fixed NO-CREATEDB/NO-CREATEROLE roles `godiffy_schema` and `godiffy_runtime`, owns the `godiffy` schema, grants only runtime DML and search path, and writes generated role credentials plus auth signing secret directly to two pre-created Secrets Manager containers. PostgreSQL 16+ CREATEROLE-created membership defaults to `SET FALSE`; bootstrap grants `SET TRUE` on **only** `godiffy_schema` to the current master so schema ownership transfer works, never to runtime. Advisory lock serializes concurrent bootstrap jobs. Re-running reuses secret values without rotating. Dedicated bootstrap role must read master and read/write only app/migration secret containers. PostgreSQL default PUBLIC CONNECT on other databases remains untouched; isolate RDS instance/database if this matters.

One-off `db:migrate`: `AWS_REGION`, `DATABASE_HOST`, optional DB port/name, `MIGRATION_SECRET_ARN`. Only schema-owner login and read-only access to migration secret. Advisory lock serializes Better Auth programmatic migrations plus `images` table/index and runtime existing/default grants. Jobs report only generic error type, not SQL, passwords, signed URLs, or SDK error details. Run bootstrap, then migration, then app. No Terraform PostgreSQL provider. Migration schema assumes default PG text user ID, Better Auth PostgreSQL core schema plus `rateLimit`, and fixed schema `godiffy` owned by `godiffy_schema`.

## Security and S3 permissions

**Production blocker:** `INVITED_EMAILS` is only an email-string allowlist, **not proof of inbox ownership**. Anyone who knows an invited address can register it first; no verified-email delivery or operator-issued one-time invitation token exists. Do not enable production registration until an architect approves a verified invitation mechanism. Empty list disables registration. Password login and sessions use Better Auth/PostgreSQL; its database-backed limiter allows at most 5 sign-in or sign-up requests per 60s key (other Better Auth defaults apply). ALB **append** mode puts the observed client IP in the last `X-Forwarded-For` position; auth routes replace the entire chain with that one syntactically valid IP (or remove a malformed value). **Task security group must allow only ALB ingress**, otherwise direct callers could spoof even that final hop. ALB client-port appending must remain disabled; malformed/no IP falls back to Better Auth's shared bucket. Never trust a caller-supplied leftmost XFF hop.

Mutations require exact `Origin: APP_URL`; auth and image endpoints reject cross-origin Fetch Metadata. Every gallery read/write filters by authenticated owner. Browser upload accepts JPEG/PNG/WebP <=10 MiB, calculates SHA-256, and gets a 5-minute S3 POST policy with fixed type/checksum and content-length range. Finalization HEAD checks size/type/checksum/version, inspects at most 64 KiB of header to verify reported format/dimensions (<=40 megapixels), then copies the **pinned source version** to `images/` and saves the **destination version**. This header check is **not full-image decoding, malware scanning, metadata stripping, or content sanitization**; corrupt trailing image data and polyglots remain possible. 2-minute download URL pins the stored version. Claims prevent concurrent finalization; crashed claim can retry after two minutes; stale copy versions are cleaned on loser/deletion races. Deletes tombstone rows and retry deletion of the recorded version. DB retains pending rows; Terraform owns pending-prefix S3 lifecycle cleanup. S3 bucket MUST enable versioning and stay private; exact-origin POST CORS is needed. Never log signed URLs.

**Exact S3 IAM object actions (SSE-S3 assumed):** `s3:PutObject` on `pending/*` for browser-signed POST and on `images/*` for destination copy; `s3:GetObject` on `pending/*` for HEAD current version, `s3:GetObjectVersion` on `pending/*` for version-pinned ranged GET and CopyObject source; `s3:GetObjectVersion` on `images/*` for pinned download; `s3:DeleteObjectVersion` on `images/*` for pinned deletion/loser cleanup. `HeadObject` and `CopyObject` are API names, **not IAM actions**. `ListBucket` is not needed for known keys. Source version copy also needs destination `PutObject`. If the bucket uses SSE-KMS instead, include narrowly scoped KMS decrypt/generate-data-key rights. Runtime task IAM reads only runtime secret; bootstrap/migration IAM duties are separate. No public ACL or credential stored in Terraform/task definition/image.

## Verification and known limits

- Frozen install, formatting, strict types and production build pass. Current
  credential-free CI runs **15 unit tests** (one integration skip without DB),
  built-server/local PostgreSQL integration with **49 assertions**, dependency
  audit (**0 advisories / 216 packages**) and non-root/read-only amd64 image smoke.
- Local PG17 uses a non-superuser database-owner/CREATEROLE master. It covers
  repeated/concurrent migration, runtime grants, auth/session/limiter persistence,
  fake-storage ownership, checksum rejection, claims and delete/finalize races.
  Presigned-policy tests check key, MIME, checksum, byte range and expiration.
  Those mocks are not real S3 or AWS RDS-master proof.
- Actual Actions private jobs subsequently exercised RDS-managed initialization,
  Secrets Manager writes, validated RDS TLS, plaintext rejection and runtime
  SQL/master/migration-secret restrictions. Final AWS HTTP/S3 auth, ownership,
  upload/download/privacy/limits/delete smoke passed. Task-recovery testing was
  not run; the deployment handoff separates these results from local tests.
- All direct dependencies remain pinned and the lockfile frozen. Nitro is still a
  beta; Vite/Rolldown emits TanStack `use client` module-directive warnings. Better
  Auth's schema validator warns that its own generated `rateLimit.lastRequest`
  bigint differs from expected `number`, despite tested PostgreSQL functionality.
  Neither warning is a production certification; monitor upstream before promotion.
- No production HTTPS/invitation, full-image decoding/malware scanning, interactive
  browser, load/restore or regional failover proof is claimed. Process probes and
  OS/dependency scans have intentionally bounded scope.

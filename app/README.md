# Godiffy — application

Single-container TanStack Start + Bun, Clerk Google sign-in, PostgreSQL gallery
records and private versioned S3 images. See the [Clerk DEV guide](../docs/clerk-dev.md)
for the cutover, exact-email restrictions and one-off approved data reset.
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
# Local isolated PostgreSQL + actual built server (no AWS):
bun run test:built
# From app/:
docker build --platform linux/amd64 -t godiffy:local .
```

Health endpoints are process-only 200 probes, independent of PostgreSQL. The
container binds port 3000, runs config preflight then `exec`s Bun, and remains
non-root (`10001:10001`), read-only and linux/amd64. The Bun 1.4.2 Alpine base is
digest-pinned; Actions requires a completed ECR scan with no critical/high findings.
Local tests own a uniquely named loopback-only PostgreSQL 17 container and use
ephemeral credentials/RSA keys without AWS access. `bun run test:built` exercises
the actual output's bearer auth, rejected old password endpoints, gallery SQL,
allowlist and CSRF boundaries. It does not test Google OAuth, AWS RDS TLS or real S3.

## Environment / operator contract

The Docker base additionally pins Alpine's published security fixes
`libcrypto3/libssl3=3.5.9-r0` and `zlib=1.3.2-r1` in a shared build/runtime base.
An unpatched Alpine candidate was also rejected (2 critical/8 high findings).
Runtime still performs no package installs and keeps the non-root/read-only contract.

Runtime requires `ENVIRONMENT=dev|prod`, `AWS_REGION`, `IMAGE_BUCKET`, `DATABASE_HOST`,
`DATABASE_SECRET_ARN`, `APP_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_ISSUER`,
`CLERK_JWT_KEY` (public PEM), and nonempty `CLERK_ALLOWED_EMAILS` (exact emails).
Defaults: DB port 5432/name `godiffy`. Production rejects HTTP and the insecure
flag, including with an HTTPS URL; DEV HTTP requires explicit opt-in. Local DB
overrides must be loopback and are rejected in production. The runtime secret uses
only `{username,password}`; the legacy `auth_secret` field is preserved but unused.
The five-connection pool validates the baked RDS CA/hostname. Credentials are
cached per process; restart tasks after manual rotation. No automatic rotation is
claimed. Clerk's 60-second bearer tokens are verified offline, without a secret
key or internet route. Tests use local ephemeral signing keys, never an auth bypass.

Bootstrap creates the restricted `godiffy_schema` / `godiffy_runtime` SQL roles
and writes credentials directly into existing Secrets Manager containers. DEV's
master-access bootstrap identity is **retired**; do not reactivate it. Existing
credentials and the legacy unused auth field are preserved. Routine migration
uses only the schema identity; runtime cannot read migration/master secrets.

One-off `db:migrate` uses the schema identity/secret, an advisory transaction lock
and fixed `godiffy.images` schema/index/grants. Ownership is a Clerk `user_*` ID,
not a foreign key into old auth tables. Existing legacy data cannot be migrated
without the explicit guarded reset. No Terraform PostgreSQL provider or master
secret is involved. Normal migrations do not delete data.

## Security and S3 permissions

Google sign-in and verified-email claims replace the old unverified password
registration. Clerk enforces the named-email allowlist on sign-up **and sign-in**;
the API independently enforces it on every gallery request. Cookies, client email
headers and old password endpoints cannot authenticate. Production is still
undeployed and requires separately reviewed production Clerk keys, OAuth
credentials, HTTPS and operational controls. DEV keys are rejected in production.

Mutations require exact `Origin: APP_URL`; auth and image endpoints reject cross-origin Fetch Metadata. Every gallery read/write filters by authenticated owner. Browser upload accepts JPEG/PNG/WebP <=10 MiB, calculates SHA-256, and gets a 5-minute S3 POST policy with fixed type/checksum and content-length range. Finalization HEAD checks size/type/checksum/version, inspects at most 64 KiB of header to verify reported format/dimensions (<=40 megapixels), then copies the **pinned source version** to `images/` and saves the **destination version**. This header check is **not full-image decoding, malware scanning, metadata stripping, or content sanitization**; corrupt trailing image data and polyglots remain possible. 2-minute download URL pins the stored version. Claims prevent concurrent finalization; crashed claim can retry after two minutes; stale copy versions are cleaned on loser/deletion races. Deletes tombstone rows and retry deletion of the recorded version. DB retains pending rows; Terraform owns pending-prefix S3 lifecycle cleanup. S3 bucket MUST enable versioning and stay private; exact-origin POST CORS is needed. Never log signed URLs.

**Exact S3 IAM object actions (SSE-S3 assumed):** `s3:PutObject` on `pending/*` for browser-signed POST and on `images/*` for destination copy; `s3:GetObject` on `pending/*` for HEAD current version, `s3:GetObjectVersion` on `pending/*` for version-pinned ranged GET and CopyObject source; `s3:GetObjectVersion` on `images/*` for pinned download; `s3:DeleteObjectVersion` on `images/*` for pinned deletion/loser cleanup. `HeadObject` and `CopyObject` are API names, **not IAM actions**. `ListBucket` is not needed for known keys. Source version copy also needs destination `PutObject`. If the bucket uses SSE-KMS instead, include narrowly scoped KMS decrypt/generate-data-key rights. Runtime task IAM reads only runtime secret; bootstrap/migration IAM duties are separate. No public ACL or credential stored in Terraform/task definition/image.

## Verification and known limits

- Before repository cleanup, local frozen install, format, strict types and build
  passed with **22 unit tests**,
  one integration skip without DB, **54** built-server/PostgreSQL assertions,
  **35** Python guard tests and **40** Terraform mock runs. Removing obsolete
  repair/recovery and password-smoke tests reduces the current suite; these counts
  describe the earlier verification, not the cleanup run. Dependency audit:
  **0 advisories / 211 packages**. Actions additionally builds/scans the image.
- Local PG17 uses a non-superuser database-owner/CREATEROLE master. It covers
  repeated/concurrent migration, runtime grants, guarded reset/rollback,
  fake-storage ownership, checksum rejection, claims and delete/finalize races.
  Presigned-policy tests check key, MIME, checksum, byte range and expiration.
  Those mocks are not real S3 or AWS RDS-master proof.
- Actual Actions private jobs subsequently exercised RDS-managed initialization,
  Secrets Manager writes, validated RDS TLS, plaintext rejection and runtime
  SQL/master/migration-secret restrictions. Historical password-release HTTP/S3
  smoke passed; this does not prove Clerk. The owner separately reported successful
  real Google/gallery/image testing and unapproved-account rejection after the
  Clerk cutover; this is manual, not agent-automated. See the current Clerk handoff.
- All direct dependencies remain pinned and the lockfile frozen. Nitro is still a
  beta; Vite/Rolldown emits TanStack `use client` module-directive warnings.
  Better Auth was removed. These checks are not production certification.
- No production HTTPS/invitation, full-image decoding/malware scanning, automated
  authenticated Google/S3 browser, load/restore or regional failover proof is claimed. Process probes and
  OS/dependency scans have intentionally bounded scope.

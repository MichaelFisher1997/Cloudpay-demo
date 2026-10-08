# Production configuration and interview walkthrough

## Scope and status

`terraform/environments/prod/` is retained as an **undeployed example/template**
showing how the same modules support stronger production settings. There is no
production pipeline in this assessment. Active development and manual delivery
use `dev` and the existing AWS DEV environment; `master` is not a release branch.
The launch gates below are future considerations, not work required for the demo.

The Terraform configures a web service, PostgreSQL backend and private S3 access.
DEV is deployed and tested. Production uses the same modules with stronger
availability settings and explicit activation gates; it is **not deployed or
operationally certified**. This code-only review does not authorize AWS, Clerk
production, certificate, DNS, IAM or database changes.

The production root now preserves Clerk and immutable release-history inputs.
Production activation rejects missing auth/origin, development credentials,
mismatched key/issuer, mutable images, missing TLS, an unready database, active
bootstrap privilege, missing alarm recipient or missing explicit review.
Runtime preflight also checks the public RSA key and prohibits HTTP/local DB
overrides. Tests use mock AWS and ephemeral local signing keys, not real production
credentials. No `CLERK_SECRET_KEY` is required or passed to ECS.

Historical validation before repository simplification: **40 Terraform mock runs, 35 Python guard tests,
22 app unit tests and 54 PostgreSQL/built-server assertions** passed, alongside
format/type checks, Actions/ShellCheck, a zero-advisory dependency audit and the
amd64 container build. Read-only/non-root container checks verified both valid
production startup and rejection of DEV auth/insecure flags. These process probes
do not prove production database connectivity or real OAuth.

## Chosen requirements and design decisions

| Requirement | Implementation and trade-off |
| --- | --- |
| Small named-user photo gallery | Verified-email allowlist in Clerk and API; signed stable Clerk user IDs own gallery rows; not a public social platform |
| Web service plus database and S3 | ALB → private Fargate → isolated PostgreSQL; private versioned S3 with authorized direct browser transfers |
| Bounded uploads | JPEG/PNG/WebP, 10 MiB limit, SHA-256 checks, pinned versions; not malware scanning/full image decoding |
| No task internet route required | AWS endpoints and offline JWT verification; Clerk/Google requests originate in the browser |
| Production AZ resilience | Two task subnets/replicas, min 2/max 4, dual-AZ endpoints and Multi-AZ RDS; no regional DR promise |
| No permanent AWS credentials | Temporary CI OIDC/task roles, separate migration/runtime roles, AWS-managed RDS master password; Terraform stores secret metadata only |
| Safe infrastructure delivery | Version locks, protected state/locking, reviewed immutable images, serialized migrations, circuit breaker and retained task history |
| Budget-conscious demo | DEV uses one replica, Single-AZ DB and one endpoint AZ; these are deliberate DEV exceptions, not production defaults |

These requirements explain the service choices; Kubernetes, Redis, NAT and WAF
are not added without a workload/threat requirement. There is no claim that every
production workload needs them. Account/region and resource names are deliberately
fixed for this assessment rather than presented as a general-purpose AWS framework.

## Required production inputs

Use `terraform/environments/prod`, its separate backend key, and separately approved
deployment identity. Defaults never enable jobs or the service.

| Input | Required value before service activation |
| --- | --- |
| `app_url` | Approved bare HTTPS application origin, matching Clerk redirect/authorized-origin and S3 CORS configuration |
| `certificate_arn` | Existing issued ACM certificate in the fixed account/region, covering the origin; creating/validating it is separately authorized |
| `alarm_email` | Operations recipient; SNS subscription confirmation and notification delivery must be checked independently |
| `production_reviewed` | Explicit `true` after review; not an IAM or organizational approval boundary |
| `release.image_digest` | Existing scanned immutable digest in the **production** ECR repository, not merely the DEV repository |
| `release.clerk_auth.publishable_key` | Production `pk_live_` key whose decoded host matches the issuer; never the shared DEV application's key |
| `release.clerk_auth.issuer` | Exact bare HTTPS production Clerk issuer; development `*.clerk.accounts.dev` issuers are rejected |
| `release.clerk_auth.jwt_key` | Matching public RSA PEM (2048+ bits, checked by runtime); no private/signing/secret key |
| `release.clerk_auth.allowed_emails` | Explicit named addresses; no wildcard or empty access policy |
| `release.database_ready` | Acknowledgment only **after** approved initialization/migrations have succeeded; not an automatic DB verification |
| `release.bootstrap_enabled` | Must be false for service activation; retire initialization access before routine releases |
| `release.service_enabled` | Enable only in the separately reviewed final activation plan |
| Retained release fields | Preserve exact previous task configuration/digests and retired bootstrap history during updates |

Terraform checks supplied values, not certificate issuance, DNS resolution, Clerk
dashboard policy, recipient confirmation or actual database readiness. Those are
deployment evidence gates. The runtime rejects a malformed/weak public key; fixture
PEMs in Terraform tests are explicitly **not** deployable keys.

## Launch gates outside this code-only review

1. Approve a separate production Clerk instance and Google OAuth setup. Configure
   exact named-email sign-up/sign-in restrictions and the same signed `email` and
   boolean `email_verified` claims, with 60-second tokens. Test real login, denial
   and image operations on the approved HTTPS origin.
2. Approve TLS/DNS integration and verify the existing certificate and origin. HTTP
   is rejected in production until an approved redirect is enabled. The internal
   ALB→task connection is still HTTP: accept that private trust boundary explicitly
   or implement backend TLS under a separate requirement.
3. Approve a protected GitHub production environment and separate scoped OIDC
   deployment authority. Existing workflows/permissions remain **DEV-only**;
   do not repoint them or reuse human administrator credentials for deployment.
   Build/scan/promote the image through the separately approved Actions path.
4. Execute approved production initialization/migrations, retire bootstrap privilege,
   review the exact saved activation plan and verify runtime DB permissions. Never
   enable the DEV reset or deploy legacy password-auth images.
5. Confirm alert delivery and capacity using production-like measurements. Proposed
   DB PITR RPO ≤15 minutes / restore RTO ≤60 minutes and AZ failover ≤5 minutes are
   review targets, **not guarantees**. Run an approved restore/failover drill before
   accepting those targets; reconcile restored metadata against S3 object versions.
6. Agree on ownership, patch/key-rotation procedures, backup retention, content threat
   model and incident response. Offline session revocation is bounded by token expiry;
   public-key rotation needs a reviewed configuration/image release.

See [operations](operations.md) for recovery details, [delivery](delivery.md) for
approval/identity boundaries and [architecture](architecture.md) for all six
Well-Architected pillars. No production apply or expensive test environment is
required to demonstrate this Terraform in the interview.

## Screen-sharing order

1. State the requirements above and distinguish verified DEV from undeployed production.
2. Show the thin roots and cohesive networking/storage/database/application modules.
3. Compare production settings: TLS gate, two private replicas, Multi-AZ DB,
   endpoint redundancy, backup retention, alarms and deletion safeguards.
4. Show production root/auth regression tests and CI: these are mock validations,
   not evidence of an AWS production deployment.
5. Show the actual DEV release, no-change plan and gallery demonstration. Explain
   its HTTP/Single-AZ cost compromises and the concrete gates before production launch.

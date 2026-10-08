# Clerk DEV sign-in and access

**Clerk is deployed and the approved DEV reset completed in Actions.**
The owner reports successful real Google/gallery/S3 testing and rejection of an
unapproved Google account. This is manual, owner-reported evidence—not an automated
authenticated browser test.
Only the dedicated `godiffy-dev` development application was created. Existing
Clerk applications (including Portyard), production, AWS networking/IAM and DNS
were not changed.

| Setting | Value |
| --- | --- |
| Application | `app_3KNzZ49PwkO5TQ7qojosOujI4z3` (`godiffy-dev`) |
| Instance | `ins_3KNzZ12dSXDsRBzB32ZAYJQXGCQ`, **development** |
| Provider | Google, Clerk's shared development OAuth credentials |
| Access | Exact verified email: `contact@michaelfisher.tech` |
| Password/email-code sign-in | Disabled |
| Standalone email sign-up | Disabled; Google only |
| Session token | 60 seconds; signed primary email and verification claims |

## Cutover evidence

| Evidence | Result |
| --- | --- |
| [Validation 37699566022](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37699566022) | Credential-free Terraform/app/PostgreSQL/container checks passed |
| [Image 37699588978](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37699588978) | Immutable image published; completed ECR scan, no findings |
| [Plan 37699841686](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37699841686) | 3 task definitions added, 1 in-place service update, no deletions/replacements/IAM changes |
| [Cutover 37700319765](https://github.com/MichaelFisher1997/Cloudpay-demo/actions/runs/37700319765) | Reviewed fingerprint matched; service reached steady state; reset/migration and both DB verifiers exited 0; Clerk boundary smoke passed; final plan had no changes |
| Anonymous live Chrome check | Google-only sign-in/sign-up, no identity/password inputs, zero page errors; reached Google OAuth and stopped before login |
| Owner-reported live manual check | Approved Google sign-in, gallery and image upload/open/download/delete passed; unapproved Google account blocked |

Source/tag: `5c2c5d86123526be4bbf1418c9015b50437c5ae4`.
Live image digest:
`sha256:0b9490fbfef66443dbca66960709e4a7c2510890b50396423fcaf369915843d1`.
The cutover finished at **23:11 UTC on 7 October 2026**. Do not repeat the reset.

## What changes

- Clerk's UI handles Google sign-up/sign-in and account controls. The gallery
  sends short-lived bearer tokens, never a client-supplied owner/email header.
- The API verifies Clerk's signature **offline**, plus the exact issuer, app
  origin (`azp`), expiry, session/user IDs, verified email and named-email allowlist.
  Old password sessions and cookies cannot authenticate. Password endpoints return
  `410`; cross-origin mutations still return `403`.
- Image ownership uses the stable Clerk `user_*` ID. There is no local account
  import/mapping because the user explicitly approved resetting all DEV demo data.
- Only Clerk's **publishable key and public signing key** enter task configuration.
  No Clerk secret key is stored in the image, Terraform or ECS. Browser-to-Clerk
  traffic is HTTPS; the private task needs no NAT or external Clerk API access.
- The API connection to the ALB is still HTTP: session tokens can be intercepted
  on that leg. This remains a non-sensitive DEV demo, **not production security**.

`app/clerk/dev.config.json` records the CLI instance patch. Public keys and the
second, server-side allowlist are in `app/clerk/dev.runtime.json` (not secrets).
`@clerk/react` is intentionally client-side: the TanStack server does not run a
Clerk handshake or `currentUser()` Backend API call from the endpoint-only VPC.

## Approved reset scope

The historical Clerk cutover supplied a one-task confirmation override to the
migration identity. That reset input has now been removed from the deployment
workflow; ordinary releases only run idempotent migrations. After the old web
deployment drained, the reset job atomically emptied exactly `images`, `user`, `session`, `account`,
`verification` and `rateLimit` in the dedicated `godiffy` schema, then removes the
old image-to-local-user foreign key. Unexpected tables/relationships, another
account/region/DB, production or local connection overrides fail closed.

The job logs only before/after row counts, not account records or credentials.
RDS, DB roles, secrets, backups, state and tables are preserved. **No S3 object or
version is deleted by the reset**; old objects are no longer linked to a gallery account.
Normal releases run an idempotent migration without resetting data. Historical
web/task revisions are preserved exactly, but legacy password releases are **not
compatible rollback targets** after this cutover.

The reset task `163cdb49591a47918a586a1133c7ff16` exited **0** after checking
zero rows inside its transaction. Its count-only committed event is in
`/ecs/godiffy-dev-application`, stream
`ecs/migrate/163cdb49591a47918a586a1133c7ff16`. Numeric pre-reset counts were not
copied here: read-only human inspection requires renewing the expired `portyard`
SSO session. No secret or account-record contents are needed for that inspection.

## Whitelisting interviewers

Use exact Google-account emails—not `@gmail.com`, a wildcard, IP addresses or a
client-side check. Both Clerk sign-up/sign-in and the API enforce the restriction.

1. Get approval for each actual Google identity email.
2. Add that email to Clerk DEV using the authenticated CLI:

   ```sh
   clerk api allowlist_identifiers \
     --app app_3KNzZ49PwkO5TQ7qojosOujI4z3 --instance dev \
     --data '{"identifier":"approved-interviewer@example.com"}' --yes
   ```

3. Add the same exact email to `allowedEmails` in `app/clerk/dev.runtime.json`.
   Commit, publish a new image and use the reviewed Actions service release.
    Whitelist changes do not require a database reset.
4. To revoke access, remove it from both layers; existing offline-verified tokens
   can last until their short expiry. Signed download URLs can last two minutes.

Inspect configuration without exposing secret keys:

```sh
clerk config pull --app app_3KNzZ49PwkO5TQ7qojosOujI4z3 --instance dev \
  --keys auth_access_control auth_email auth_password session
clerk api allowlist_identifiers --app app_3KNzZ49PwkO5TQ7qojosOujI4z3 --instance dev
clerk api jwks --app app_3KNzZ49PwkO5TQ7qojosOujI4z3 --instance dev
```

If Clerk rotates its signing key, refresh the pinned **public** PEM and release a
new image/configuration. Verification fails closed rather than fetching keys over
an unavailable internet route. Do not pull or commit secret API keys.

## Verification boundary

Local tests use ephemeral RSA keys, isolated PostgreSQL and mock S3. They test
signature/claims, wrong-email/origin/issuer/expiry denial, reset refusal/rollback,
empty tables, stable Clerk-ID ownership and the actual built HTTP server.
The successful Actions smoke checked deployed public configuration, old-auth
retirement and anonymous/spoofed access denial; it did **not** manufacture a Google
login or prove authenticated S3 browser behavior. Fresh headless Chrome checks
passed first against the local build under the exact HTTP ALB origin, then against
the actual live ALB and real Clerk DEV: Google-only sign-in/sign-up, no identity or
password fields, zero page errors and successful Google OAuth handoff. Both stopped
before login. No user or authenticated session was manufactured.

The owner subsequently reported Google sign-in, gallery access and a non-sensitive
image upload/open/download/delete all passed, and an unapproved Google account was
blocked. The agent did not inspect the real token's contents or automate that
authenticated flow. No fake Clerk users or sessions were created.

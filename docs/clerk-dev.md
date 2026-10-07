# Clerk DEV sign-in and access

**Clerk is configured; the live cutover/reset awaits the reviewed Actions release.**
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
| Session token | 60 seconds; signed primary email and verification claims |

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

Manual `dev-deploy.yml` **service apply** with `reset_dev_data=true` supplies a
one-task confirmation override to the migration identity. It is off by default
and never stored in a standing task definition. After the old web deployment has
drained, the job atomically empties exactly `images`, `user`, `session`, `account`,
`verification` and `rateLimit` in the dedicated `godiffy` schema, then removes the
old image-to-local-user foreign key. Unexpected tables/relationships, another
account/region/DB, production or local connection overrides fail closed.

The job logs only before/after row counts, not account records or credentials.
RDS, DB roles, secrets, backups, state and tables are preserved. **No S3 object or
version is deleted**; old objects are no longer linked to a gallery account.
Normal releases run an idempotent migration without resetting data. Historical
web/task revisions are preserved exactly, but legacy password releases are **not
compatible rollback targets** after this cutover.

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
   **Do not set `reset_dev_data=true` for whitelist changes.**
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
The Actions smoke tests deployed public configuration, old-auth retirement and
anonymous/spoofed access denial; it does **not** manufacture a Google login or
claim a real authenticated S3 browser test. A fresh local headless Chrome check
served the actual built app under the exact non-local HTTP ALB origin, with real
Clerk DEV traffic: Google-only UI, no email/password fields, zero page errors,
and a Google OAuth redirect all passed. It stopped before Google sign-in and
made no AWS calls. No user or authenticated session was manufactured.

After deployment, the owner must complete Google sign-in on the live site and
upload/download/delete one non-sensitive image, then confirm an unapproved Google
account cannot join. No fake Clerk users or sessions have been created.

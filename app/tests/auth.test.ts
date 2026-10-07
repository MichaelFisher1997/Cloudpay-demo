import { expect, test, spyOn } from "bun:test";
import { authenticatedOwner, authSettings } from "../src/server/auth";
import { approvedDevReset, resetConfirmation } from "../src/server/dev-reset";
import { tokenFixture } from "./token-fixture";

const fixture = tokenFixture();
const request = (token: string) =>
  new Request(`${fixture.settings.origin}/api/images/`, {
    headers: { authorization: `Bearer ${token}` },
  });

test("Clerk signature and named verified email checked without network access", async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("No network allowed"),
  );
  try {
    expect(
      await authenticatedOwner(request(fixture.token()), fixture.settings),
    ).toBe("user_localOwner");
    expect(
      await authenticatedOwner(
        request(fixture.token({ email: "OWNER@EXAMPLE.TEST" })),
        fixture.settings,
      ),
    ).toBe("user_localOwner");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

test("Clerk rejects forged, expired, wrong-issuer/origin and incomplete sessions", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { email: "outsider@example.test" },
    { email: "owner+extra@example.test" },
    { email_verified: false },
    { email_verified: "true" },
    { email_verified: undefined },
    { iss: "https://other.clerk.accounts.dev" },
    { azp: "https://attacker.invalid" },
    { azp: undefined },
    { sub: "legacy-user-id" },
    { sid: undefined },
    { sts: "pending" },
    { iat: now - 180, nbf: now - 180, exp: now - 120 },
    { exp: now + 3600 },
    { nbf: now + 120 },
  ])
    expect(
      await authenticatedOwner(
        request(fixture.token(claims)),
        fixture.settings,
      ),
    ).toBeNull();
  expect(
    await authenticatedOwner(request(tokenFixture().token()), fixture.settings),
  ).toBeNull();
  expect(
    await authenticatedOwner(request("malformed"), fixture.settings),
  ).toBeNull();
});

test("Legacy cookies and client-controlled email/user headers never authenticate", async () => {
  expect(
    await authenticatedOwner(
      new Request(`${fixture.settings.origin}/api/images/`, {
        headers: {
          cookie: "better-auth.session_token=old",
          "x-user-id": "user_localOwner",
          "x-email": "owner@example.test",
        },
      }),
      fixture.settings,
    ),
  ).toBeNull();
});

test("Clerk runtime requires environment-matched public keys and exact emails", () => {
  const env = {
    ENVIRONMENT: "dev",
    APP_URL: fixture.settings.origin,
    AWS_REGION: "eu-west-2",
    IMAGE_BUCKET: "local",
    DATABASE_HOST: "local",
    DATABASE_SECRET_ARN: "local",
    CLERK_PUBLISHABLE_KEY: fixture.settings.publishableKey,
    CLERK_ISSUER: fixture.settings.issuer,
    CLERK_JWT_KEY: fixture.settings.jwtKey,
    CLERK_ALLOWED_EMAILS: "owner@example.test",
  };
  expect(authSettings(env).allowedEmails.has("owner@example.test")).toBe(true);
  for (const change of [
    { ENVIRONMENT: "prod" },
    { CLERK_PUBLISHABLE_KEY: "pk_live_invalid" },
    { CLERK_ISSUER: "https://another.clerk.accounts.dev" },
    { CLERK_JWT_KEY: "not a public key" },
    { CLERK_ALLOWED_EMAILS: "" },
    { CLERK_ALLOWED_EMAILS: "*@example.test" },
  ])
    expect(() => authSettings({ ...env, ...change })).toThrow();
});

test("Approved reset fails closed on wrong account, environment, DB, region or secret", () => {
  const env = {
    GODIFFY_DEV_RESET_CONFIRMATION: resetConfirmation,
    ENVIRONMENT: "dev",
    AWS_REGION: "eu-west-2",
    DATABASE_NAME: "godiffy",
    DATABASE_HOST: "godiffy-dev-postgres.fixture.eu-west-2.rds.amazonaws.com",
    MIGRATION_SECRET_ARN:
      "arn:aws:secretsmanager:eu-west-2:218549829565:secret:godiffy-dev-migration-ABC123",
  };
  expect(approvedDevReset({})).toBe(false);
  expect(approvedDevReset(env)).toBe(true);
  for (const change of [
    { GODIFFY_DEV_RESET_CONFIRMATION: "yes" },
    { ENVIRONMENT: "prod" },
    { AWS_REGION: "eu-west-1" },
    { DATABASE_NAME: "portyard" },
    { DATABASE_HOST: "portyard.fixture.eu-west-2.rds.amazonaws.com" },
    { DATABASE_URL: "postgres://localhost/godiffy" },
    {
      MIGRATION_SECRET_ARN: env.MIGRATION_SECRET_ARN.replace(
        "218549829565",
        "123456789012",
      ),
    },
    {
      MIGRATION_SECRET_ARN: env.MIGRATION_SECRET_ARN.replace(
        "migration",
        "runtime",
      ),
    },
  ])
    expect(() => approvedDevReset({ ...env, ...change })).toThrow();
});

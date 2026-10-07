import { generateKeyPairSync, sign } from "node:crypto";
import type { AuthSettings } from "../src/server/auth";

// Ephemeral local-only signing keys. There is no test bypass in runtime code.
export function tokenFixture(origin = "https://gallery.example") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const host = "test-issuer.clerk.accounts.dev";
  const settings: AuthSettings = {
    origin,
    issuer: `https://${host}`,
    publishableKey: `pk_test_${Buffer.from(`${host}$`).toString("base64")}`,
    jwtKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    allowedEmails: new Set(["owner@example.test", "other@example.test"]),
  };
  const token = (overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: settings.issuer,
      azp: origin,
      sub: "user_localOwner",
      sid: "sess_localSession",
      iat: now,
      nbf: now - 1,
      exp: now + 60,
      v: 2,
      email: "owner@example.test",
      email_verified: true,
      ...overrides,
    };
    const body = [
      Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT", kid: "local-test" }),
      ).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
    ].join(".");
    return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
  };
  return { settings, token };
}

import { verifyToken } from "@clerk/backend";
import { createPublicKey } from "node:crypto";
import { config, required } from "./config";

export interface AuthSettings {
  origin: string;
  issuer: string;
  publishableKey: string;
  jwtKey: string;
  allowedEmails: Set<string>;
}

export function authSettings(
  env: Record<string, string | undefined> = process.env,
): AuthSettings {
  const c = config(env);
  const publishableKey = required(
    env.CLERK_PUBLISHABLE_KEY,
    "CLERK_PUBLISHABLE_KEY",
  );
  const prefix = c.environment === "dev" ? "pk_test_" : "pk_live_";
  if (!publishableKey.startsWith(prefix))
    throw new Error("Wrong Clerk environment");
  const host = Buffer.from(publishableKey.slice(prefix.length), "base64")
    .toString("utf8")
    .replace(/\$$/, "");
  const issuer = required(env.CLERK_ISSUER, "CLERK_ISSUER");
  if (
    issuer !== `https://${host}` ||
    (c.environment === "dev" &&
      !/^[a-z0-9-]+\.clerk\.accounts\.dev$/.test(host))
  )
    throw new Error("Wrong Clerk issuer");
  const jwtKey = required(env.CLERK_JWT_KEY, "CLERK_JWT_KEY");
  const key = createPublicKey(jwtKey);
  if (
    !jwtKey.startsWith("-----BEGIN PUBLIC KEY-----") ||
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw new Error("Invalid Clerk public key");
  const allowedEmails = new Set(
    (env.CLERK_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    !allowedEmails.size ||
    [...allowedEmails].some(
      (email) => !/^[^@\s*]+@[^@\s*]+\.[^@\s*]+$/.test(email),
    )
  )
    throw new Error("A named-email Clerk allowlist is required");
  return { origin: c.origin, issuer, publishableKey, jwtKey, allowedEmails };
}

export async function authenticatedOwner(
  req: Request,
  settings: AuthSettings,
): Promise<string | null> {
  // Explicit bearer tokens avoid Clerk's server-side handshake/API calls in the
  // endpoint-only VPC. Never accept old cookies, user IDs or client email headers.
  const token = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(
    req.headers.get("authorization") ?? "",
  )?.[1];
  if (!token) return null;
  try {
    const claims = await verifyToken(token, {
      jwtKey: settings.jwtKey,
      authorizedParties: [settings.origin],
      clockSkewInMs: 1_000,
    });
    if (
      claims.iss !== settings.issuer ||
      claims.azp !== settings.origin ||
      !/^user_[A-Za-z0-9]+$/.test(claims.sub) ||
      typeof claims.sid !== "string" ||
      !/^sess_[A-Za-z0-9]+$/.test(claims.sid) ||
      (claims.sts !== undefined && claims.sts !== "active") ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number" ||
      claims.exp - claims.iat > 65 ||
      claims.exp <= claims.iat ||
      claims.email_verified !== true ||
      typeof claims.email !== "string" ||
      !settings.allowedEmails.has(claims.email.toLowerCase())
    )
      return null;
    return claims.sub;
  } catch {
    // Do not log tokens, Clerk errors, claims or keys.
    return null;
  }
}

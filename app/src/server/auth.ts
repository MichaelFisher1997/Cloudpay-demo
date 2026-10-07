import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import type { Pool } from "pg";
import { config } from "./config";
import { runtime } from "./db";

export type AuthSettings = Pick<
  ReturnType<typeof config>,
  "origin" | "secure" | "invites"
>;

export function createAuth(
  db: Pool,
  authSecret: string,
  settings: AuthSettings,
  migrating = false,
) {
  return betterAuth({
    database: db,
    secret: authSecret,
    baseURL: settings.origin,
    trustedOrigins: [settings.origin],
    emailAndPassword: { enabled: true },
    advanced: {
      defaultCookieAttributes: {
        secure: settings.secure,
        sameSite: "lax",
        httpOnly: true,
      },
      database: { validateSchema: !migrating },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!settings.invites.has(user.email.toLowerCase())) {
              throw new APIError("FORBIDDEN", {
                message: "Invitation required",
              });
            }
            return { data: user };
          },
        },
      },
    },
  });
}

let instance: Promise<ReturnType<typeof createAuth>> | undefined;
export function authInstance() {
  return (instance ??= (async () => {
    const settings = config();
    const { db, authSecret } = await runtime();
    return createAuth(db, authSecret, settings);
  })().catch((error) => {
    instance = undefined;
    throw error;
  }));
}

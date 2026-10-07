export function required(value: string | undefined, key: string): string {
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

export function config(env: Record<string, string | undefined> = process.env) {
  const environment = required(env.ENVIRONMENT, "ENVIRONMENT");
  if (environment !== "dev" && environment !== "prod")
    throw new Error("Invalid ENVIRONMENT");
  const appUrl = new URL(required(env.APP_URL, "APP_URL"));
  if (
    appUrl.protocol !== "https:" &&
    !(
      environment === "dev" &&
      appUrl.protocol === "http:" &&
      env.ALLOW_INSECURE_HTTP === "true"
    )
  ) {
    throw new Error("HTTPS required except explicit development bootstrap");
  }
  if (environment === "prod" && env.ALLOW_INSECURE_HTTP === "true")
    throw new Error("Insecure HTTP flag prohibited in production");
  if (
    appUrl.username ||
    appUrl.password ||
    appUrl.search ||
    appUrl.hash ||
    appUrl.pathname !== "/"
  ) {
    throw new Error("APP_URL must be an origin");
  }
  if (
    env.DATABASE_URL &&
    (environment === "prod" || env.NODE_ENV === "production")
  ) {
    throw new Error("DATABASE_URL is local-only");
  }
  if (
    env.DATABASE_URL &&
    !["localhost", "127.0.0.1"].includes(new URL(env.DATABASE_URL).hostname)
  ) {
    throw new Error("DATABASE_URL must target localhost");
  }
  const port = Number(env.DATABASE_PORT ?? "5432");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid DATABASE_PORT");
  return {
    environment,
    origin: appUrl.origin,
    secure: appUrl.protocol === "https:",
    region: required(env.AWS_REGION, "AWS_REGION"),
    bucket: required(env.IMAGE_BUCKET, "IMAGE_BUCKET"),
    host: required(env.DATABASE_HOST, "DATABASE_HOST"),
    port,
    database: env.DATABASE_NAME ?? "godiffy",
    secretArn: required(env.DATABASE_SECRET_ARN, "DATABASE_SECRET_ARN"),
    invites: new Set(
      (env.INVITED_EMAILS ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
    localUrl: env.DATABASE_URL,
  };
}

export function sameOrigin(req: Request, origin: string): boolean {
  if (req.headers.get("origin") !== origin) return false;
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin";
}

export function uploadInput(
  type: string,
  size: number,
  checksum: string,
): boolean {
  return (
    ["image/jpeg", "image/png", "image/webp"].includes(type) &&
    Number.isInteger(size) &&
    size > 0 &&
    size <= 10 * 1024 * 1024 &&
    /^[A-Za-z0-9+/]{43}=$/.test(checksum)
  );
}

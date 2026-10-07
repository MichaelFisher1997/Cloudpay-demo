import { required } from "../src/server/config";
import expected from "../clerk/dev.runtime.json";

const origin = required(process.env.APP_URL, "APP_URL");
if (
  !/^http:\/\/godiffy-dev-[a-z0-9-]+\.eu-west-2\.elb\.amazonaws\.com$/.test(
    origin,
  )
)
  throw new Error("Smoke must target the dedicated DEV ALB");
let checks = 0;
async function check(path: string, status: number, options: RequestInit = {}) {
  const response = await fetch(origin + path, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== status)
    throw new Error(`Clerk boundary check failed: ${path}`);
  checks++;
  return response;
}
try {
  for (const path of ["/", "/health/live", "/health/ready"])
    await check(path, 200);
  const response = await check("/api/auth/config", 200);
  const config = await response.json();
  if (
    Object.keys(config).join() !== "publishableKey" ||
    config.publishableKey !== expected.publishableKey
  )
    throw new Error("Unexpected deployed Clerk configuration");
  await check("/api/images/", 401);
  const deniedHeaders: Record<string, string>[] = [
    { cookie: "better-auth.session_token=retired" },
    { authorization: "Bearer not.a.valid-token" },
    { "x-user-id": "user_spoofed", "x-user-email": expected.allowedEmails[0]! },
  ];
  for (const headers of deniedHeaders)
    await check("/api/images/", 401, { headers });
  for (const path of ["/api/auth/sign-in/email", "/api/auth/sign-up/email"])
    await check(path, 410, {
      method: "POST",
      headers: { origin, "Content-Type": "application/json" },
      body: "{}",
    });
  await check("/api/auth/get-session", 410);
  await check("/api/images/", 403, {
    method: "POST",
    headers: {
      origin: "http://attacker.invalid",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  await check("/api/images/", 401, {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: "{}",
  });
  await Bun.write(
    "/tmp/godiffyClerkSmoke.json",
    JSON.stringify(
      {
        origin,
        checks,
        outcome: "PASS",
        authenticatedGoogleAndS3BrowserFlow: "manual verification required",
      },
      null,
      2,
    ),
  );
  console.log(
    "Deployed Clerk configuration, retired password auth and closed API boundaries: PASS",
  );
} catch {
  console.error("Clerk deployment boundary smoke failed");
  process.exitCode = 1;
}

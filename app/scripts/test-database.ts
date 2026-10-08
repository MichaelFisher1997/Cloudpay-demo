// Local/CI only. Uses an isolated PostgreSQL container; never calls AWS.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const name = `godiffy-pg-test-${randomBytes(6).toString("hex")}`;
const password = randomBytes(32).toString("base64url");
const app = resolve(import.meta.dir, "..");
let created = false;
const localEnv: Record<string, string | undefined> = {
  ...process.env,
  AWS_CONFIG_FILE: "/dev/null",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
  AWS_EC2_METADATA_DISABLED: "true",
};
for (const key of [
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
])
  delete localEnv[key];

async function docker(args: string[], extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn(["docker", ...args], {
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, status] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
    // Drain without printing errors that might expose environment details.
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error("Isolated Docker test operation failed");
  return output.trim();
}

try {
  await docker(
    [
      "run",
      "--detach",
      "--name",
      name,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_USER",
      "--env",
      "POSTGRES_DB",
      "postgres:17-alpine",
    ],
    {
      POSTGRES_PASSWORD: password,
      POSTGRES_USER: "godiffy_master",
      POSTGRES_DB: "godiffy",
    },
  );
  created = true;
  // Initialization uses a temporary Unix-socket server that stops before the
  // final server starts. Wait for TCP, the same transport used by the tests.
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await docker([
        "exec",
        name,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "godiffy_master",
        "-d",
        "godiffy",
      ]);
      ready = true;
      break;
    } catch {
      await Bun.sleep(500);
    }
  }
  if (!ready) throw new Error("PostgreSQL readiness timeout");
  const mapping = await docker(["port", name, "5432/tcp"]);
  const port = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
  if (!port) throw new Error("Unexpected PostgreSQL port mapping");
  const tests = Bun.spawn(["bun", "test", "tests/integration.test.ts"], {
    cwd: app,
    env: {
      ...localEnv,
      PG_TEST_URL: `postgres://godiffy_master:${password}@127.0.0.1:${port}/godiffy`,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await tests.exited) !== 0)
    throw new Error("PostgreSQL integration failed");
  console.log(
    "Isolated PostgreSQL integration passed; no AWS services were used.",
  );
} finally {
  // Only our exact, randomly named container is stopped. No containers/volumes are deleted.
  if (created) await docker(["stop", name]);
}

// No AWS calls or credentials. Inspect only our locally built image and own containers.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import clerk from "../app/clerk/dev.runtime.json";

const image = process.argv[2] ?? "godiffy:validation";
if (!/^godiffy:(validation|local|final)$/.test(image))
  throw new Error("Use a locally built Godiffy test image");

// Local fixture only: no real production Clerk instance, session or private key
// is passed to the container. Preflight must accept the production key contract.
const productionAuth = {
  publishableKey: `pk_live_${Buffer.from("clerk.gallery.example$").toString("base64")}`,
  issuer: "https://clerk.gallery.example",
  jwtKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString(),
  allowedEmails: ["owner@example.invalid"],
};

async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [output, status] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (status !== 0) throw new Error("Isolated image smoke operation failed");
    return output.trim();
  } finally {
    clearTimeout(timer);
  }
}

const shape = JSON.parse(
  await docker(["image", "inspect", image, "--format", "{{json .}}"]),
);
if (shape.Architecture !== "amd64" || shape.Config.User !== "10001:10001")
  throw new Error("Unexpected runtime architecture/user");

async function run(
  environment: "dev" | "prod",
  origin: string,
  options: {
    insecure?: boolean;
    liveAuth?: boolean;
    expectFailure?: boolean;
  } = {},
) {
  const auth = options.liveAuth ? productionAuth : clerk;
  const name = `godiffy-image-smoke-${randomBytes(6).toString("hex")}`;
  let started = false;
  try {
    await docker([
      "run",
      "--detach",
      "--pull=never",
      "--name",
      name,
      "--read-only",
      "--user",
      "10001:10001",
      "--publish",
      "127.0.0.1::3000",
      "--env",
      `ENVIRONMENT=${environment}`,
      "--env",
      `APP_URL=${origin}`,
      "--env",
      `ALLOW_INSECURE_HTTP=${options.insecure ?? true}`,
      "--env",
      "AWS_REGION=eu-west-2",
      "--env",
      "AWS_EC2_METADATA_DISABLED=true",
      "--env",
      "IMAGE_BUCKET=godiffy-dev-smoke-unused",
      "--env",
      "DATABASE_HOST=database.invalid",
      "--env",
      "DATABASE_SECRET_ARN=local-smoke-unused",
      "--env",
      `CLERK_PUBLISHABLE_KEY=${auth.publishableKey}`,
      "--env",
      `CLERK_ISSUER=${auth.issuer}`,
      "--env",
      `CLERK_JWT_KEY=${auth.jwtKey}`,
      "--env",
      `CLERK_ALLOWED_EMAILS=${auth.allowedEmails.join(",")}`,
      image,
    ]);
    started = true;
    if (options.expectFailure ?? environment === "prod") {
      const exit = await docker(["wait", name]);
      if (exit !== "1")
        throw new Error("Production accepted an invalid configuration");
      console.log(
        `Production rejected ${options.insecure === false ? "development auth" : "an insecure HTTP flag"}.`,
      );
      return;
    }
    const mapping = await docker(["port", name, "3000/tcp"]);
    const port = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
    if (!port) throw new Error("Unexpected smoke port mapping");
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        ready =
          (
            await fetch(`${base}/health/live`, {
              signal: AbortSignal.timeout(1000),
            })
          ).status === 200;
        if (ready) break;
      } catch {
        /* Startup may not have bound the port yet. */
      }
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("Read-only non-root image failed to start");
    for (const path of ["/", "/health/live", "/health/ready"]) {
      if (
        (await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) }))
          .status !== 200
      )
        throw new Error("Image route smoke failed");
    }
    console.log(
      `Read-only, non-root amd64 image (${environment} config): UI and process probes return 200; no DB/OAuth proof claimed.`,
    );
  } finally {
    // Stop only our own exact container. No unrelated containers, images or volumes are deleted.
    if (started) await docker(["stop", "--time", "5", name]);
  }
}

await run("dev", "http://dev-smoke.invalid");
await run("prod", "http://dev-smoke.invalid");
await run("prod", "https://dev-smoke.invalid");
await run("prod", "https://gallery.example", { insecure: false });
await run("prod", "https://gallery.example", {
  insecure: false,
  liveAuth: true,
  expectFailure: false,
});

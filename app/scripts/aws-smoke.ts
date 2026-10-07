import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { smokeInputs, s3Url } from "./aws-smoke-guard";

const ownerEmail = "smoke-owner@godiffy.invalid";
const otherEmail = "smoke-other@godiffy.invalid";
// A real, one-pixel PNG; use the actual bytes for the signed checksum and size.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9fZp8AAAAASUVORK5CYII=",
  "base64",
);
const checksum = createHash("sha256").update(png).digest("base64");
type Fixture = { ownerPassword: string; otherPassword: string };
type Result = { check: string; status: "pass" | "fail"; httpStatus?: number };
const evidence: { results: Result[]; outcome: "pass" | "fail" } = {
  results: [],
  outcome: "fail",
};
let step = "configuration";
function assert(ok: unknown): asserts ok {
  if (!ok) throw new Error("assertion failed");
}
function record(name: string, status?: number) {
  evidence.results.push({
    check: name,
    status: "pass",
    ...(status === undefined ? {} : { httpStatus: status }),
  });
}
function expectStatus(response: Response, allowed: number[], name: string) {
  assert(allowed.includes(response.status));
  record(name, response.status);
}
function json(response: Response): Promise<unknown> {
  return response.json(); // Never log response bodies.
}
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  assert(typeof value === "string" && value.length > 0);
  return value;
}
function cookie(response: Response): string {
  const values = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0]!);
  assert(values.length > 0);
  return values.join("; ");
}
function s3Form(fields: Record<string, string>, bytes: Buffer) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: "image/png" }),
    "smoke.png",
  ); // file MUST be last.
  return form;
}

async function main() {
  // Guard before any AWS call or network request.
  const c = smokeInputs(process.env);
  record("dev target guard");
  for (const path of ["/", "/health/live", "/health/ready"]) {
    const response = await fetch(`${c.origin}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    expectStatus(response, [200], `HTTP ${path}`);
  }
  const sm = new SecretsManagerClient({ region: c.region });
  step = "fixture secret";
  const saved = await sm
    .send(new GetSecretValueCommand({ SecretId: c.fixtureArn }))
    .catch((error: unknown) => {
      // Terraform creates the container, not a secret version. Do not swallow
      // access-denied/network failures or overwrite a malformed saved fixture.
      if (error instanceof Error && error.name === "ResourceNotFoundException")
        return {};
      throw new Error("fixture read failed");
    });
  let fixture: Fixture;
  if (!("SecretString" in saved) || !saved.SecretString) {
    fixture = {
      ownerPassword: randomBytes(48).toString("base64url"),
      otherPassword: randomBytes(48).toString("base64url"),
    };
    // Persist before signup: retries only ever reuse the saved credentials.
    await sm.send(
      new PutSecretValueCommand({
        SecretId: c.fixtureArn,
        SecretString: JSON.stringify(fixture),
      }),
    );
  } else {
    const parsed = object(JSON.parse(saved.SecretString));
    fixture = {
      ownerPassword: string(parsed.ownerPassword),
      otherPassword: string(parsed.otherPassword),
    };
    assert(
      fixture.ownerPassword.length >= 32 && fixture.otherPassword.length >= 32,
    );
  }
  record("persisted disposable fixture");

  const created: string[] = [];
  async function app(
    path: string,
    method = "GET",
    body?: unknown,
    session?: string,
    origin = c.origin,
  ) {
    return fetch(`${c.origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        "Sec-Fetch-Site": origin === c.origin ? "same-origin" : "cross-site",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(session ? { Cookie: session } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  }
  const imagePath = (id: string) => `/api/images/${encodeURIComponent(id)}`;
  async function signup(email: string, password: string) {
    return app("/api/auth/sign-up/email", "POST", {
      name: "Smoke fixture",
      email,
      password,
    });
  }
  async function login(email: string, password: string) {
    return app("/api/auth/sign-in/email", "POST", { email, password });
  }
  let ownerSession: string | undefined;
  try {
    step = "authentication";
    const initial = await signup(ownerEmail, fixture.ownerPassword);
    expectStatus(initial, [200, 201, 422], "owner signup or existing fixture");
    const otherInitial = await signup(otherEmail, fixture.otherPassword);
    expectStatus(
      otherInitial,
      [200, 201, 422],
      "other signup or existing fixture",
    );
    const outsider = await signup(
      `uninvited-${randomUUID()}@godiffy.invalid`,
      randomBytes(32).toString("base64url"),
    );
    expectStatus(outsider, [403], "uninvited signup denied");
    const wrong = await login(
      ownerEmail,
      randomBytes(32).toString("base64url"),
    );
    expectStatus(wrong, [400, 401, 403], "wrong password denied");
    const ownerLogin = await login(ownerEmail, fixture.ownerPassword);
    expectStatus(ownerLogin, [200], "persisted owner login");
    ownerSession = cookie(ownerLogin);
    const otherLogin = await login(otherEmail, fixture.otherPassword);
    expectStatus(otherLogin, [200], "other login");
    const otherSession = cookie(otherLogin);
    let rateLimited = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const denied = await login(
        ownerEmail,
        randomBytes(32).toString("base64url"),
      );
      assert([400, 401, 403, 429].includes(denied.status));
      if (denied.status === 429) {
        rateLimited = true;
        break;
      }
    }
    assert(rateLimited);
    record("database-backed login rate limit", 429);
    if (process.env.SMOKE_REPLACE_TASK === "true") {
      step = "authorized single-task recovery";
      const command = Bun.spawn(
        [
          "python3",
          "../scripts/verify-dev.py",
          "--replace-task",
          "--outputs",
          "../terraform/environments/dev/deployment.json",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(command.stdout).text();
      await new Response(command.stderr).text(); // Discard; never dump SDK errors.
      assert((await command.exited) === 0);
      assert(object(JSON.parse(output)).outcome === "pass");
      record("single-task replaced; saved sessions retained");
    }
    expectStatus(await app("/api/images/"), [401], "anonymous gallery denied");
    const ownerList = await app("/api/images/", "GET", undefined, ownerSession);
    expectStatus(ownerList, [200], "owner gallery list");
    assert(Array.isArray(object(await json(ownerList)).images));
    const otherList = await app("/api/images/", "GET", undefined, otherSession);
    expectStatus(otherList, [200], "other gallery list");

    step = "upload validation";
    const input = {
      name: `smoke-${randomUUID()}.png`,
      contentType: "image/png",
      size: png.length,
      checksum,
    };
    for (const [name, invalid] of [
      ["checksum input rejected", { ...input, checksum: "invalid" }],
      ["oversize input rejected", { ...input, size: 10 * 1024 * 1024 + 1 }],
      ["file type rejected", { ...input, contentType: "text/plain" }],
    ] as const)
      expectStatus(
        await app("/api/images/", "POST", invalid, ownerSession),
        [400],
        name,
      );
    expectStatus(
      await app(
        "/api/images/",
        "POST",
        input,
        ownerSession,
        "https://untrusted.invalid",
      ),
      [403],
      "cross origin denied",
    );
    const init = await app("/api/images/", "POST", input, ownerSession);
    expectStatus(init, [200], "signed upload initiated");
    const signed = object(await json(init));
    const id = string(signed.id);
    assert(/^[0-9a-f-]{36}$/.test(id));
    created.push(id); // cleanup ONLY this invocation's created IDs
    const upload = s3Url(string(signed.url), c.bucket, c.region);
    const fields = object(signed.fields) as Record<string, string>;
    assert(Object.values(fields).every((value) => typeof value === "string"));
    assert(
      fields["x-amz-checksum-sha256"] === checksum &&
        fields["Content-Type"] === "image/png",
    );
    const preflight = await fetch(upload, {
      method: "OPTIONS",
      headers: {
        Origin: c.origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-amz-checksum-sha256",
      },
    });
    expectStatus(preflight, [200], "S3 POST preflight");
    assert(preflight.headers.get("access-control-allow-origin") === c.origin);
    record("S3 POST origin restricted");
    const changed = { ...fields, "Content-Type": "image/jpeg" };
    expectStatus(
      await fetch(upload, {
        method: "POST",
        body: s3Form(changed, png),
        headers: { Origin: c.origin },
      }),
      [400, 403],
      "altered signed policy denied",
    );
    const mismatch = Buffer.from(png);
    mismatch[mismatch.length - 1] ^= 1;
    expectStatus(
      await fetch(upload, {
        method: "POST",
        body: s3Form(fields, mismatch),
        headers: { Origin: c.origin },
      }),
      [400, 403],
      "checksum mismatch denied",
    );
    expectStatus(
      await fetch(upload, {
        method: "POST",
        body: s3Form(fields, Buffer.alloc(10 * 1024 * 1024 + 1)),
        headers: { Origin: c.origin },
      }),
      [400, 403],
      "signed POST oversize denied",
    );
    expectStatus(
      await fetch(upload, {
        method: "POST",
        body: s3Form(fields, png),
        headers: { Origin: c.origin },
      }),
      [200, 201, 204],
      "signed POST uploaded",
    );
    const anonymousHead = await fetch(upload, {
      method: "HEAD",
      redirect: "manual",
    });
    expectStatus(anonymousHead, [403], "anonymous S3 HEAD denied");
    for (const [name, path, method] of [
      ["other complete denied", `${imagePath(id)}/complete`, "POST"],
      ["other download denied", `${imagePath(id)}/download`, "GET"],
      ["other delete denied", imagePath(id), "DELETE"],
    ] as const)
      expectStatus(
        await app(path, method, undefined, otherSession),
        [403, 404],
        name,
      );
    const foreignList = await app(
      "/api/images/",
      "GET",
      undefined,
      otherSession,
    );
    expectStatus(foreignList, [200], "other gallery isolated");
    assert(
      !(object(await json(foreignList)).images as unknown[]).some(
        (entry) => object(entry).id === id,
      ),
    );
    const completed = await app(
      `${imagePath(id)}/complete`,
      "POST",
      undefined,
      ownerSession,
    );
    expectStatus(completed, [200], "owner completes verified image");
    assert(object(await json(completed)).status === "ready");
    const download = await app(
      `${imagePath(id)}/download`,
      "GET",
      undefined,
      ownerSession,
    );
    expectStatus(download, [200], "owner download issued");
    const signedDownload = s3Url(
      string(object(await json(download)).url),
      c.bucket,
      c.region,
    );
    const privateObject = new URL(signedDownload);
    privateObject.search = "";
    expectStatus(
      await fetch(privateObject, { method: "HEAD", redirect: "manual" }),
      [403],
      "anonymous image object HEAD denied",
    );
    const getPreflight = await fetch(signedDownload, {
      method: "OPTIONS",
      headers: { Origin: c.origin, "Access-Control-Request-Method": "GET" },
    });
    expectStatus(getPreflight, [200], "S3 GET preflight");
    assert(
      getPreflight.headers.get("access-control-allow-origin") === c.origin,
    );
    record("S3 GET origin restricted");
    const bytes = await fetch(signedDownload, {
      headers: { Origin: c.origin },
    });
    expectStatus(bytes, [200], "signed full download");
    assert(bytes.headers.get("access-control-allow-origin") === c.origin);
    assert(Buffer.from(await bytes.arrayBuffer()).equals(png));
    record("download bytes equal original");
    expectStatus(
      await app(imagePath(id), "DELETE", undefined, ownerSession),
      [204],
      "owner delete",
    );
    created.pop();
    expectStatus(
      await app(imagePath(id), "DELETE", undefined, ownerSession),
      [204],
      "owner delete idempotent",
    );
    expectStatus(
      await app(`${imagePath(id)}/download`, "GET", undefined, ownerSession),
      [404],
      "deleted image unavailable",
    );
    evidence.outcome = "pass";
  } finally {
    // Do not delete previous runs' images, users, or objects directly.
    for (const id of created) {
      if (!ownerSession) break;
      try {
        const result = await app(
          imagePath(id),
          "DELETE",
          undefined,
          ownerSession,
        );
        if (result.status !== 204) {
          evidence.results.push({
            check: "cleanup",
            status: "fail",
            httpStatus: result.status,
          });
          evidence.outcome = "fail";
        }
      } catch {
        evidence.results.push({ check: "cleanup", status: "fail" });
        evidence.outcome = "fail";
      }
    }
  }
}

try {
  await main();
} catch {
  evidence.results.push({ check: step, status: "fail" });
  process.exitCode = 1;
} finally {
  try {
    await writeFile(
      process.env.EVIDENCE_PATH ?? "/tmp/godiffyAWSsmoke.json",
      JSON.stringify(evidence) + "\n",
      { mode: 0o600 },
    );
  } catch {
    process.exitCode = 1;
  }
  if (evidence.outcome !== "pass") process.exitCode = 1;
  console.log(
    `AWS smoke: ${evidence.outcome === "pass" && !process.exitCode ? "PASS" : "FAIL"}`,
  );
}

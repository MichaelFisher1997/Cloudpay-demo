import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { config, sameOrigin, uploadInput } from "../src/server/config";
import { smallJson } from "../src/server/http";
import { normalizeAlbClientIp } from "../src/server/alb-ip";
import { pool } from "../src/server/db";
import {
  owned,
  completionState,
  deletionVersion,
  createUploadPost,
  type Image,
} from "../src/server/images";
const env = {
  ENVIRONMENT: "dev",
  APP_URL: "https://gallery.example",
  AWS_REGION: "us-east-1",
  IMAGE_BUCKET: "example",
  DATABASE_HOST: "db.example",
  DATABASE_SECRET_ARN: "example",
};
test("HTTP requires explicit bootstrap opt-in", () => {
  expect(() => config({ ...env, APP_URL: "http://gallery.example" })).toThrow();
  expect(
    config({
      ...env,
      APP_URL: "http://gallery.example",
      ALLOW_INSECURE_HTTP: "true",
    }).secure,
  ).toBe(false);
});
test("production blocks local database bypass", () =>
  expect(() =>
    config({
      ...env,
      ENVIRONMENT: "prod",
      DATABASE_URL: "postgres://localhost/test",
    }),
  ).toThrow());
test("production rejects HTTP even with the bootstrap flag", () => {
  expect(() =>
    config({
      ...env,
      ENVIRONMENT: "prod",
      APP_URL: "http://gallery.example",
      ALLOW_INSECURE_HTTP: "true",
    }),
  ).toThrow();
  expect(() =>
    config({ ...env, ENVIRONMENT: "prod", ALLOW_INSECURE_HTTP: "true" }),
  ).toThrow();
  expect(() => config({ ...env, ENVIRONMENT: "invalid" })).toThrow();
  expect(() => config({ ...env, ENVIRONMENT: undefined })).toThrow();
});
test("invites disabled by default", () =>
  expect(config(env).invites.size).toBe(0));
test("mutations require exact origin, including port", () => {
  expect(
    sameOrigin(
      new Request("https://gallery.example", {
        headers: { origin: "https://gallery.example" },
      }),
      env.APP_URL,
    ),
  ).toBe(true);
  for (const origin of [
    "https://gallery.example.evil",
    "http://gallery.example",
    "https://gallery.example:444",
  ])
    expect(
      sameOrigin(
        new Request("https://gallery.example", { headers: { origin } }),
        env.APP_URL,
      ),
    ).toBe(false);
  expect(sameOrigin(new Request("https://gallery.example"), env.APP_URL)).toBe(
    false,
  );
  expect(
    sameOrigin(
      new Request("https://gallery.example", {
        headers: { origin: env.APP_URL, "sec-fetch-site": "cross-site" },
      }),
      env.APP_URL,
    ),
  ).toBe(false);
});
test("upload MIME, bounded length and checksum enforced", () => {
  const sha = "A".repeat(43) + "=";
  expect(uploadInput("image/png", 10485760, sha)).toBe(true);
  expect(uploadInput("image/svg+xml", 100, sha)).toBe(false);
  expect(uploadInput("image/png", 10485761, sha)).toBe(false);
  expect(uploadInput("image/png", 1, "invalid")).toBe(false);
});
test("ownership hides other users and deleted images", () => {
  const image = { owner_id: "alice", status: "ready" } as Image;
  expect(owned(image, "bob")).toBeNull();
  expect(owned({ ...image, status: "deleted" }, "alice")).toBeNull();
  expect(owned(image, "alice")).toBe(image);
});

test("finalization retries return ready without another copy; deleted is absent", () => {
  const base = { id: "1", owner_id: "a", status: "pending" } as Image;
  expect(completionState(owned(base, "a"))).toBe("claim");
  expect(completionState(owned({ ...base, status: "ready" }, "a"))).toBe(
    "ready",
  );
  expect(completionState(owned({ ...base, status: "deleted" }, "a"))).toBe(
    "missing",
  );
});
test("tombstoned delete retries use the same pinned object version", () => {
  const image = {
    status: "deleted",
    image_key: "images/a/1",
    version_id: "v1",
  } as Image;
  expect(deletionVersion(image)).toEqual({ key: "images/a/1", version: "v1" });
  expect(deletionVersion({ ...image, version_id: null })).toBeNull();
});
test("JSON request parser rejects oversize and invalid payloads", async () => {
  await expect(
    smallJson(
      new Request("https://example.test", {
        method: "POST",
        body: "x".repeat(2049),
      }),
    ),
  ).rejects.toThrow("Body too large");
  await expect(
    smallJson(
      new Request("https://example.test", {
        method: "POST",
        body: "{invalid",
      }),
    ),
  ).rejects.toThrow("Invalid JSON");
});
test("local presigned POST policy binds checksum, MIME, key, size and five minutes", async () => {
  const client = new S3Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: `LOCAL${randomBytes(8).toString("hex")}`,
      secretAccessKey: randomBytes(32).toString("hex"),
    },
  });
  const checksum = randomBytes(32).toString("base64");
  const post = await createUploadPost(
    client,
    "local-test-bucket",
    "pending/user/id",
    "image/png",
    checksum,
  );
  const policy = JSON.parse(
    Buffer.from(post.fields.Policy!, "base64").toString(),
  );
  expect(post.fields["x-amz-checksum-sha256"]).toBe(checksum);
  expect(post.fields["Content-Type"]).toBe("image/png");
  expect(policy.conditions).toContainEqual({ key: "pending/user/id" });
  expect(policy.conditions).toContainEqual([
    "content-length-range",
    1,
    10 * 1024 * 1024,
  ]);
  expect(policy.conditions).toContainEqual([
    "eq",
    "$Content-Type",
    "image/png",
  ]);
  expect(policy.conditions).toContainEqual([
    "eq",
    "$x-amz-checksum-sha256",
    checksum,
  ]);
  expect(new Date(policy.expiration).getTime() - Date.now()).toBeGreaterThan(
    295_000,
  );
  client.destroy();
});
test("ALB append mode drops spoofed earlier hops and rejects malformed final hop", async () => {
  const req = new Request("http://localhost/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "x-forwarded-for": "198.51.100.99, 203.0.113.8",
      "content-type": "application/json",
    },
    body: '{"email":"placeholder@example.test"}',
  });
  const normalized = normalizeAlbClientIp(req);
  expect(normalized.headers.get("x-forwarded-for")).toBe("203.0.113.8");
  expect(await normalized.text()).toContain("placeholder@example.test");
  expect(
    normalizeAlbClientIp(
      new Request("http://localhost", {
        headers: { "x-forwarded-for": "198.51.100.99, invalid" },
      }),
    ).headers.has("x-forwarded-for"),
  ).toBe(false);
  expect(
    normalizeAlbClientIp(
      new Request("http://localhost", {
        headers: { "x-forwarded-for": "2001:db8::1, 2001:db8::2" },
      }),
    ).headers.get("x-forwarded-for"),
  ).toBe("2001:db8::2");
});
test("idle database pool error is handled without logging details", async () => {
  const original = console.error;
  const messages: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args);
  };
  const db = pool(
    "localhost",
    5432,
    "test",
    { username: "", password: "" },
    "postgres://localhost/test",
  );
  try {
    db.emit("error", new Error("sensitive connection detail"), {} as never);
    expect(messages).toEqual([["Idle PostgreSQL connection failed"]]);
  } finally {
    await db.end();
    console.error = original;
  }
});

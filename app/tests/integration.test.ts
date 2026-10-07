import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { createAuth } from "../src/server/auth";
import {
  imageService,
  ConflictError,
  type Storage,
} from "../src/server/images";
import { bootstrap, migrate, type SecretStore } from "../src/server/jobs";

const url = process.env.PG_TEST_URL;
const local = url ? describe : describe.skip;

async function awaitClaim(db: Pool, id: string, completion: Promise<unknown>) {
  const deadline = Date.now() + 4_500;
  let settled = false;
  void completion.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (Date.now() < deadline) {
    if (
      (await db.query("SELECT status FROM images WHERE id=$1", [id])).rows[0]
        ?.status === "finalizing"
    )
      return;
    if (settled) throw new Error("Finalization ended before obtaining claim");
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for finalization claim");
}

local("PostgreSQL 17 integration (isolated local test container)", () => {
  test("roles, idempotent migration, auth, ownership, S3 lifecycle without AWS", async () => {
    const address = new URL(url!);
    const admin = new Pool({ connectionString: url, max: 5 });
    const simulatedPassword = randomBytes(32).toString("base64url");
    const masterName = "godiffy_master_sim";
    const create = await admin.query<{ sql: string }>(
      "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER CREATEROLE CREATEDB PASSWORD %L', $1::text, $2::text) AS sql",
      [masterName, simulatedPassword],
    );
    await admin.query(create.rows[0]!.sql);
    await admin.query(`ALTER DATABASE godiffy OWNER TO ${masterName}`);
    const master = new Pool({
      host: address.hostname,
      port: Number(address.port),
      database: "godiffy",
      user: masterName,
      password: simulatedPassword,
      max: 5,
    });
    const secrets = new Map<string, Record<string, string>>();
    const store: SecretStore = {
      get: async (id) => secrets.get(id) ?? null,
      put: async (id, value) => {
        secrets.set(id, value);
      },
    };
    const ids = { runtime: "runtime-test", migration: "migration-test" };
    const connections: Pool[] = [admin, master];
    const connectAs = (username: string, password: string) => {
      const db = new Pool({
        host: address.hostname,
        port: Number(address.port),
        database: "godiffy",
        user: username,
        password,
        max: 5,
      });
      connections.push(db);
      return db;
    };
    const request = (path: string, body: unknown) =>
      new Request(`https://gallery.example/api/auth/${path}`, {
        method: "POST",
        headers: {
          origin: "https://gallery.example",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let releaseClaim: (() => void) | undefined;
    let releaseDeleteClaim: (() => void) | undefined;
    try {
      expect(
        (
          await master.query(
            "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
          )
        ).rows[0].rolsuper,
      ).toBe(false);
      expect(
        (
          await master.query(
            "SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user",
          )
        ).rows[0].rolcreaterole,
      ).toBe(true);
      await bootstrap(master, store, "godiffy", ids);
      const roleSet = await master.query(
        "SELECT pg_has_role(current_user, 'godiffy_schema', 'SET') AS schema_owner, pg_has_role(current_user, 'godiffy_runtime', 'SET') AS runtime, pg_has_role('godiffy_runtime', 'godiffy_schema', 'SET') AS runtime_to_schema",
      );
      expect(roleSet.rows[0]).toMatchObject({
        schema_owner: true,
        runtime: false,
        runtime_to_schema: false,
      });
      const initialSecrets = JSON.stringify([...secrets]);
      await bootstrap(master, store, "godiffy", ids);
      expect(JSON.stringify([...secrets])).toBe(initialSecrets);
      const migration = connectAs(
        "godiffy_schema",
        secrets.get(ids.migration)!.password!,
      );
      await migrate(migration);
      await migrate(migration);
      await Promise.all([migrate(migration), migrate(migration)]);
      const runtime = connectAs(
        "godiffy_runtime",
        secrets.get(ids.runtime)!.password!,
      );
      expect(
        (await runtime.query("SHOW search_path")).rows[0].search_path,
      ).toBe("godiffy, public");
      expect(
        (await runtime.query('SELECT count(*) FROM "rateLimit"')).rowCount,
      ).toBe(1);
      await expect(
        runtime.query("CREATE TABLE godiffy.not_allowed(id int)"),
      ).rejects.toThrow();
      await master.query("CREATE SCHEMA operator_private");
      await master.query(
        "CREATE TABLE operator_private.private_data(secret text)",
      );
      await expect(
        runtime.query("SELECT * FROM operator_private.private_data"),
      ).rejects.toThrow();
      await migration.query("CREATE TABLE godiffy.future_grant_test(id int)");
      await runtime.query(
        "INSERT INTO godiffy.future_grant_test(id) VALUES (1)",
      );
      expect(
        (await runtime.query("SELECT id FROM godiffy.future_grant_test"))
          .rows[0].id,
      ).toBe(1);

      const settings = {
        origin: "https://gallery.example",
        secure: true,
        invites: new Set<string>(),
      };
      const auth = createAuth(
        runtime,
        secrets.get(ids.runtime)!.auth_secret!,
        settings,
      );
      const invited = `invited-${randomBytes(8).toString("hex")}@example.test`;
      const blocked = `blocked-${randomBytes(8).toString("hex")}@example.test`;
      const password = randomBytes(24).toString("base64url");
      settings.invites.add(invited);
      const rejected = await auth.handler(
        request("sign-up/email", { name: "No", email: blocked, password }),
      );
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(
        (await runtime.query('SELECT id FROM "user" WHERE email=$1', [blocked]))
          .rows,
      ).toHaveLength(0);
      const signup = await auth.handler(
        request("sign-up/email", { name: "Invited", email: invited, password }),
      );
      expect(signup.status).toBe(200);
      const login = await auth.handler(
        request("sign-in/email", { email: invited, password }),
      );
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: cookie! }),
      });
      expect(session?.user.email).toBe(invited);
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
          auth.handler(
            request("sign-in/email", { email: invited, password: "incorrect" }),
          ),
        ),
      );
      expect(attempts.some((response) => response.status === 429)).toBe(true);
      expect(
        Number(
          (await runtime.query('SELECT count(*) FROM "rateLimit"')).rows[0]
            .count,
        ),
      ).toBeGreaterThan(0);
      const userId = session!.user.id;
      const stranger = randomBytes(8).toString("hex");

      const png = Uint8Array.from(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XyZkAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      const checksum = randomBytes(32).toString("base64");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      releaseClaim = release;
      let blockHead = true;
      const copies: Array<{ sourceVersion: string; target: string }> = [];
      const deletes: Array<{ key: string; version: string }> = [];
      const storage: Storage = {
        signedPost: async () => ({
          url: "https://storage.invalid",
          fields: {},
        }),
        head: async () => {
          if (blockHead) await gate;
          return {
            version: "source-v1",
            size: png.length,
            type: "image/png",
            checksum,
            etag: "etag-v1",
          };
        },
        header: async (_, __, version) => {
          expect(version).toBe("source-v1");
          return png;
        },
        copy: async (_, __, sourceVersion, target) => {
          copies.push({ sourceVersion, target });
          return "destination-v2";
        },
        delete: async (_, key, version) => {
          deletes.push({ key, version });
        },
        signedDownload: async (_, __, version) =>
          `https://storage.invalid/${version}`,
      };
      const images = imageService(runtime, storage, "test-bucket");
      const upload = await images.initiate(userId, {
        name: "photo.png",
        contentType: "image/png",
        size: png.length,
        checksum,
      });
      expect(await images.complete(upload.id, stranger)).toBeNull();
      expect(await images.download(upload.id, stranger)).toBeNull();
      expect(await images.remove(upload.id, stranger)).toBe(false);
      const first = images.complete(upload.id, userId);
      await awaitClaim(runtime, upload.id, first);
      await expect(images.complete(upload.id, userId)).rejects.toBeInstanceOf(
        ConflictError,
      );
      blockHead = false;
      release();
      expect((await first)?.status).toBe("ready");
      expect(await images.complete(upload.id, userId)).toEqual({
        id: upload.id,
        status: "ready",
      });
      expect(copies).toEqual([
        { sourceVersion: "source-v1", target: `images/${userId}/${upload.id}` },
      ]);
      expect((await images.download(upload.id, userId))?.url).toEndWith(
        "destination-v2",
      );
      expect(await images.remove(upload.id, userId)).toBe(true);
      expect(await images.remove(upload.id, userId)).toBe(true);
      expect(deletes).toEqual([
        { key: `images/${userId}/${upload.id}`, version: "destination-v2" },
        { key: `images/${userId}/${upload.id}`, version: "destination-v2" },
      ]);
      expect(await images.download(upload.id, userId)).toBeNull();
      expect(await images.list(userId)).toHaveLength(0);
      const mismatch = imageService(
        runtime,
        {
          ...storage,
          head: async () => ({
            version: "source-v1",
            size: png.length,
            type: "image/png",
            checksum: "wrong",
          }),
        },
        "test-bucket",
      );
      const invalid = await mismatch.initiate(userId, {
        name: "bad.png",
        contentType: "image/png",
        size: png.length,
        checksum,
      });
      await expect(mismatch.complete(invalid.id, userId)).rejects.toThrow(
        "Upload verification failed",
      );
      expect(
        (
          await runtime.query("SELECT status FROM images WHERE id=$1", [
            invalid.id,
          ])
        ).rows[0].status,
      ).toBe("pending");

      let releaseDelete!: () => void;
      const deleteGate = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      releaseDeleteClaim = releaseDelete;
      const raced = imageService(
        runtime,
        {
          ...storage,
          head: async () => {
            await deleteGate;
            return {
              version: "source-v1",
              size: png.length,
              type: "image/png",
              checksum,
            };
          },
        },
        "test-bucket",
      );
      const other = await raced.initiate(userId, {
        name: "race.png",
        contentType: "image/png",
        size: png.length,
        checksum,
      });
      const inFlight = raced.complete(other.id, userId);
      await awaitClaim(runtime, other.id, inFlight);
      expect(await raced.remove(other.id, userId)).toBe(true);
      releaseDelete();
      expect(await inFlight).toBeNull();
      expect(await raced.download(other.id, userId)).toBeNull();
      expect(deletes.at(-1)).toEqual({
        key: `images/${userId}/${other.id}`,
        version: "destination-v2",
      });
      if (process.env.BUILT_SMOKE === "1") {
        await smokeBuiltRuntime(
          address,
          secrets.get(ids.runtime)!.password!,
          secrets.get(ids.runtime)!.auth_secret!,
        );
      }
    } finally {
      releaseClaim?.();
      releaseDeleteClaim?.();
      await Promise.all(connections.map((db) => db.end()));
    }
  }, 120_000);
});

async function smokeBuiltRuntime(
  address: URL,
  password: string,
  authSecret: string,
) {
  const reserved = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reserved.port;
  reserved.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const invited = `smoke-${randomBytes(8).toString("hex")}@example.test`;
  const credentials = randomBytes(24).toString("base64url");
  const app = Bun.spawn(["bun", ".output/server/index.mjs"], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      NODE_ENV: "development",
      ENVIRONMENT: "dev",
      ALLOW_INSECURE_HTTP: "true",
      APP_URL: origin,
      AWS_REGION: "us-east-1",
      IMAGE_BUCKET: "unused-local-smoke",
      DATABASE_HOST: "127.0.0.1",
      DATABASE_SECRET_ARN: "unused-local-smoke",
      DATABASE_URL: `postgres://godiffy_runtime:${encodeURIComponent(password)}@127.0.0.1:${address.port}/godiffy`,
      LOCAL_AUTH_SECRET: authSecret,
      INVITED_EMAILS: invited,
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: String(port),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const headers = {
    origin,
    "content-type": "application/json",
    "x-forwarded-for": "198.51.100.17, 203.0.113.22",
  };
  const post = (
    path: string,
    body: unknown,
    customHeaders: Record<string, string> = headers,
  ) =>
    fetch(origin + path, {
      method: "POST",
      headers: customHeaders,
      body: JSON.stringify(body),
    });
  try {
    const deadline = Date.now() + 4_500;
    let live = false;
    while (Date.now() < deadline) {
      try {
        live = (await fetch(origin + "/health/live")).ok;
      } catch {
        /* startup */
      }
      if (live) break;
      await Bun.sleep(20);
    }
    expect(live).toBe(true);
    expect(
      (
        await post(
          "/api/auth/sign-up/email",
          { email: invited, name: "Smoke", password: credentials },
          { ...headers, origin: "http://attacker.invalid" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post("/api/auth/sign-up/email", {
          email: "not-invited@example.test",
          name: "No",
          password: credentials,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await post("/api/auth/sign-up/email", {
          email: invited,
          name: "Smoke",
          password: credentials,
        })
      ).status,
    ).toBe(200);
    const login = await post("/api/auth/sign-in/email", {
      email: invited,
      password: credentials,
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const session = await fetch(origin + "/api/auth/get-session", {
      headers: { cookie: cookie! },
    });
    expect(session.status).toBe(200);
    expect((await session.json()).user.email).toBe(invited);
    const gallery = await fetch(origin + "/api/images/", {
      headers: { cookie: cookie! },
    });
    expect(gallery.status).toBe(200);
    expect((await gallery.json()).images).toEqual([]);
    expect(
      (
        await post(
          "/api/images/",
          {},
          { ...headers, cookie: cookie!, origin: "http://attacker.invalid" },
        )
      ).status,
    ).toBe(403);
  } finally {
    app.kill("SIGTERM");
    await app.exited;
  }
}

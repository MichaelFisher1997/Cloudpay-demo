import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { tokenFixture } from "./token-fixture";
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
      // Model the previous deployed schema and data, without retaining the old
      // authentication library. Reset is atomic, limited to the explicit tables.
      await migration.query('CREATE TABLE "user" (id text PRIMARY KEY)');
      for (const table of ["session", "account", "verification", "rateLimit"])
        await migration.query(`CREATE TABLE "${table}" (id text PRIMARY KEY)`);
      await migration.query("INSERT INTO \"user\" VALUES ('legacy-user')");
      await migration.query(
        "INSERT INTO \"session\" VALUES ('legacy-session')",
      );
      await migration.query(
        'ALTER TABLE images ADD CONSTRAINT images_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES "user"(id)',
      );
      await migration.query(`INSERT INTO images(id,owner_id,name,status,pending_key,checksum,content_type,bytes)
        VALUES('11111111-1111-4111-8111-111111111111','legacy-user','old.png','pending','pending/legacy','checksum','image/png',1)`);
      await expect(migrate(migration)).rejects.toThrow(
        "approved DEV data reset",
      );
      expect(
        (await migration.query("SELECT count(*)::int AS count FROM images"))
          .rows[0].count,
      ).toBe(1);
      await migration.query("CREATE TABLE unknown_operator_table(id int)");
      await expect(migrate(migration, { resetDevData: true })).rejects.toThrow(
        "Unexpected DEV schema",
      );
      expect(
        (await migration.query("SELECT count(*)::int AS count FROM images"))
          .rows[0].count,
      ).toBe(1);
      await migration.query("DROP TABLE unknown_operator_table"); // Only our isolated local fixture.
      await migration.query(
        "ALTER TABLE images RENAME CONSTRAINT images_owner_id_fkey TO operator_relationship",
      );
      await expect(migrate(migration, { resetDevData: true })).rejects.toThrow(
        "Unexpected legacy ownership constraint",
      );
      expect(
        (await migration.query("SELECT count(*)::int AS count FROM images"))
          .rows[0].count,
      ).toBe(1); // TRUNCATE rolled back with the unexpected relationship.
      await migration.query(
        "ALTER TABLE images RENAME CONSTRAINT operator_relationship TO images_owner_id_fkey",
      );
      await migrate(migration, { resetDevData: true });
      for (const table of [
        "images",
        "user",
        "session",
        "account",
        "verification",
        "rateLimit",
      ])
        expect(
          (
            await migration.query(
              `SELECT count(*)::int AS count FROM "${table}"`,
            )
          ).rows[0].count,
        ).toBe(0);
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

      const userId = "user_localOwner";
      const stranger = "user_localOther";

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
        await smokeBuiltRuntime(address, secrets.get(ids.runtime)!.password!);
      }
    } finally {
      releaseClaim?.();
      releaseDeleteClaim?.();
      await Promise.all(connections.map((db) => db.end()));
    }
  }, 120_000);
});

async function smokeBuiltRuntime(address: URL, password: string) {
  const reserved = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reserved.port;
  reserved.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const fixture = tokenFixture(origin);
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
      CLERK_PUBLISHABLE_KEY: fixture.settings.publishableKey,
      CLERK_ISSUER: fixture.settings.issuer,
      CLERK_JWT_KEY: fixture.settings.jwtKey,
      CLERK_ALLOWED_EMAILS: [...fixture.settings.allowedEmails].join(","),
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
          {},
          { ...headers, origin: "http://attacker.invalid" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post("/api/auth/sign-up/email", {})).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await post("/api/auth/sign-up/email", {})).status).toBe(410);
    expect((await post("/api/auth/sign-in/email", {})).status).toBe(410);
    const publicConfig = await fetch(origin + "/api/auth/config");
    expect(publicConfig.status).toBe(200);
    expect(await publicConfig.json()).toEqual({
      publishableKey: fixture.settings.publishableKey,
    });
    expect((await fetch(origin + "/api/images/")).status).toBe(401);
    expect(
      (
        await fetch(origin + "/api/images/", {
          headers: {
            authorization: `Bearer ${fixture.token({ email: "outsider@example.test" })}`,
          },
        })
      ).status,
    ).toBe(401);
    const authorization = `Bearer ${fixture.token()}`;
    const gallery = await fetch(origin + "/api/images/", {
      headers: { authorization },
    });
    expect(gallery.status).toBe(200);
    expect(Array.isArray((await gallery.json()).images)).toBe(true);
    expect(
      (
        await post(
          "/api/images/",
          {},
          { ...headers, authorization, origin: "http://attacker.invalid" },
        )
      ).status,
    ).toBe(403);
  } finally {
    app.kill("SIGTERM");
    await app.exited;
  }
}

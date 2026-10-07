import { randomBytes } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import type { Pool, PoolClient } from "pg";
import { createAuth } from "./auth";

export interface SecretStore {
  get(id: string): Promise<Record<string, string> | null>;
  put(id: string, value: Record<string, string>): Promise<void>;
}

export interface JobSecrets {
  runtime: string;
  migration: string;
}

const roleNames = {
  runtime: "godiffy_runtime",
  migration: "godiffy_schema",
} as const;

function validateDatabase(database: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(database))
    throw new Error("Invalid database name");
  return database;
}

async function role(
  client: PoolClient,
  store: SecretStore,
  id: string,
  username: string,
  auth: boolean,
) {
  const saved = await store.get(id);
  if (
    saved &&
    (saved.username !== username ||
      !saved.password ||
      (auth && (!saved.auth_secret || saved.auth_secret.length < 32)))
  )
    throw new Error("Existing secret has unexpected shape");
  const value = saved ?? {
    username,
    password: randomBytes(48).toString("base64url"),
    ...(auth ? { auth_secret: randomBytes(48).toString("base64url") } : {}),
  };
  const present = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname=$1",
    [username],
  );
  if (!present.rowCount) {
    // Identifiers are fixed; pg's format() safely quotes both identifiers and passwords.
    const sql = await client.query<{ sql: string }>(
      "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', $1::text, $2::text) AS sql",
      [username, value.password],
    );
    await client.query(sql.rows[0]!.sql);
  }
  if (!saved) {
    const sql = await client.query<{ sql: string }>(
      "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
      [username, value.password],
    );
    await client.query(sql.rows[0]!.sql);
    await store.put(id, value);
  }
  return value;
}

export async function bootstrap(
  db: Pool,
  store: SecretStore,
  databaseName: string,
  ids: JobSecrets,
) {
  const database = validateDatabase(databaseName);
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(728193)");
    await role(client, store, ids.migration, roleNames.migration, false);
    await role(client, store, ids.runtime, roleNames.runtime, true);
    // PG16+ gives a CREATEROLE creator ADMIN but not SET membership by default.
    // Schema ownership transfer requires SET on the owner role. Grant this to
    // the current bootstrap master only, never to the runtime role.
    const grantSet = await client.query<{ sql: string }>(
      "SELECT format('GRANT %I TO %I WITH SET TRUE', $1::text, current_user) AS sql",
      [roleNames.migration],
    );
    await client.query(grantSet.rows[0]!.sql);
    await client.query(
      `GRANT CONNECT ON DATABASE "${database}" TO godiffy_schema,godiffy_runtime`,
    );
    await client.query(
      "CREATE SCHEMA IF NOT EXISTS godiffy AUTHORIZATION godiffy_schema",
    );
    await client.query("ALTER SCHEMA godiffy OWNER TO godiffy_schema");
    await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    await client.query("GRANT USAGE ON SCHEMA godiffy TO godiffy_runtime");
    await client.query(
      `ALTER ROLE godiffy_schema IN DATABASE "${database}" SET search_path=godiffy,public`,
    );
    await client.query(
      `ALTER ROLE godiffy_runtime IN DATABASE "${database}" SET search_path=godiffy,public`,
    );
    await client.query(
      "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA godiffy TO godiffy_runtime",
    );
    await client.query(
      "GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA godiffy TO godiffy_runtime",
    );
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(728193)")
      .finally(() => client.release());
  }
}

export async function migrate(db: Pool) {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(728194)");
    const auth = createAuth(
      db,
      "migration-only-placeholder-not-used-for-auth",
      {
        origin: "https://migration.invalid",
        secure: true,
        invites: new Set(),
      },
      true,
    );
    await (await getMigrations(auth.options)).runMigrations();
    await client.query(`CREATE TABLE IF NOT EXISTS images (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL REFERENCES "user"(id),
      name text NOT NULL,
      status text NOT NULL CHECK(status IN ('pending','finalizing','ready','deleted')),
      pending_key text NOT NULL UNIQUE,
      image_key text, version_id text, checksum text NOT NULL,
      content_type text NOT NULL, bytes integer NOT NULL,
      width integer, height integer,
      claim_token uuid, claimed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(
      "CREATE INDEX IF NOT EXISTS images_owner_created ON images(owner_id,created_at DESC)",
    );
    await client.query(
      "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA godiffy TO godiffy_runtime",
    );
    await client.query(
      "GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA godiffy TO godiffy_runtime",
    );
    await client.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA godiffy GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO godiffy_runtime",
    );
    await client.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA godiffy GRANT USAGE,SELECT ON SEQUENCES TO godiffy_runtime",
    );
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(728194)")
      .finally(() => client.release());
  }
}

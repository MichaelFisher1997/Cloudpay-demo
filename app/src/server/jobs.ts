import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

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
) {
  const saved = await store.get(id);
  if (saved && (saved.username !== username || !saved.password))
    throw new Error("Existing secret has unexpected shape");
  const value = saved ?? {
    username,
    password: randomBytes(48).toString("base64url"),
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
    await role(client, store, ids.migration, roleNames.migration);
    await role(client, store, ids.runtime, roleNames.runtime);
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

const demoTables = [
  "images",
  "user",
  "session",
  "account",
  "verification",
  "rateLimit",
] as const;

async function resetDemoData(client: PoolClient) {
  const identity = await client.query<{ database: string; username: string }>(
    "SELECT current_database() AS database, current_user AS username",
  );
  if (
    identity.rows[0]?.database !== "godiffy" ||
    identity.rows[0]?.username !== "godiffy_schema"
  )
    throw new Error("Unexpected reset database identity");
  const result = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='godiffy' ORDER BY tablename",
  );
  const tables = result.rows.map(({ tablename }) => tablename);
  if (
    !tables.length ||
    tables.some(
      (name) => !demoTables.includes(name as (typeof demoTables)[number]),
    )
  )
    throw new Error("Unexpected DEV schema; reset refused");
  // Identifiers come only from the fixed list above. No CASCADE, schema drop,
  // role/secret changes or S3 operations are permitted in the approved data reset.
  const qualified = tables.map((table) => `godiffy."${table}"`).join(", ");
  await client.query(`LOCK TABLE ${qualified} IN ACCESS EXCLUSIVE MODE`);
  const before: Record<string, number> = {};
  for (const table of tables)
    before[table] = Number(
      (await client.query(`SELECT count(*) AS count FROM godiffy."${table}"`))
        .rows[0].count,
    );
  await client.query(`TRUNCATE TABLE ${qualified}`);
  for (const table of tables) {
    if (
      Number(
        (await client.query(`SELECT count(*) AS count FROM godiffy."${table}"`))
          .rows[0].count,
      ) !== 0
    )
      throw new Error("DEV reset verification failed");
  }
  return before;
}

export async function migrate(
  db: Pool,
  options: { resetDevData?: boolean } = {},
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock(728194)");
    const resetCounts = options.resetDevData
      ? await resetDemoData(client)
      : null;
    const legacy = await client.query<{
      conname: string;
      local_user: boolean;
    }>(
      `SELECT conname, confrelid=to_regclass('godiffy."user"') AS local_user
       FROM pg_constraint WHERE contype='f'
       AND conrelid=to_regclass('godiffy.images')`,
    );
    if (legacy.rowCount) {
      if (
        legacy.rows.length !== 1 ||
        legacy.rows[0]!.conname !== "images_owner_id_fkey" ||
        !legacy.rows[0]!.local_user
      )
        throw new Error("Unexpected legacy ownership constraint");
      if (!options.resetDevData)
        throw new Error(
          "Legacy auth cutover requires the approved DEV data reset",
        );
      await client.query(
        "ALTER TABLE godiffy.images DROP CONSTRAINT images_owner_id_fkey",
      );
    }
    await client.query(`CREATE TABLE IF NOT EXISTS godiffy.images (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL,
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
      "CREATE INDEX IF NOT EXISTS images_owner_created ON godiffy.images(owner_id,created_at DESC)",
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
    await client.query("COMMIT");
    if (resetCounts)
      console.log(
        JSON.stringify({
          event: "Approved DEV data reset committed",
          before: resetCounts,
          after: 0,
          s3: "untouched",
        }),
      );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

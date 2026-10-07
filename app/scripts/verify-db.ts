import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { config } from "../src/server/config";
import { runtime } from "../src/server/db";

async function main() {
  const c = config();
  if (
    c.environment !== "dev" ||
    c.region !== "eu-west-2" ||
    c.localUrl ||
    c.bucket !== "godiffy-dev-images-218549829565-eu-west-2" ||
    !/^godiffy-dev-[a-z0-9-]+\.eu-west-2\.elb\.amazonaws\.com$/.test(
      new URL(c.origin).hostname,
    ) ||
    !/^arn:aws:secretsmanager:eu-west-2:218549829565:secret:godiffy-dev-runtime-[A-Za-z0-9]{6}$/.test(
      c.secretArn,
    ) ||
    c.secretArn.split(":")[4] !== c.bucket.split("-")[3]
  )
    throw new Error("configuration");
  const db = (await runtime()).db; // Existing pool requires verified RDS CA and rejectUnauthorized.
  try {
    const result = await db.query<{
      ssl: boolean;
      version: string;
      cipher: string;
      username: string;
      create_schema: boolean;
      create_role: boolean;
      create_db: boolean;
      select_images: boolean;
    }>(`SELECT s.ssl, s.version, s.cipher, current_user AS username,
      has_schema_privilege(current_user, 'godiffy', 'CREATE') AS create_schema,
      r.rolcreaterole AS create_role, r.rolcreatedb AS create_db,
      has_table_privilege(current_user, 'godiffy.images', 'SELECT') AS select_images
      FROM pg_stat_ssl s JOIN pg_roles r ON r.rolname=current_user
      WHERE s.pid=pg_backend_pid()`);
    const row = result.rows[0];
    if (
      !row?.ssl ||
      !row.version.startsWith("TLS") ||
      !row.cipher ||
      row.username !== "godiffy_runtime" ||
      row.create_schema ||
      row.create_role ||
      row.create_db ||
      !row.select_images
    )
      throw new Error("permissions");
    await db.query("SELECT id FROM godiffy.images LIMIT 0");
    console.log("Database TLS, runtime permissions and gallery SELECT: PASS");
  } finally {
    await db.end();
  }
  const sm = new SecretsManagerClient({ region: c.region });
  for (const name of ["MASTER_SECRET_ARN", "MIGRATION_SECRET_ARN"] as const) {
    const arn = process.env[name];
    if (
      !arn ||
      !new RegExp(
        `^arn:aws:secretsmanager:eu-west-2:${c.bucket.split("-")[3]}:secret:${name === "MASTER_SECRET_ARN" ? "rds!db-[A-Za-z0-9!_-]+" : "godiffy-dev-(?:schema|migration)-[A-Za-z0-9-]+"}$`,
      ).test(arn) ||
      arn === c.secretArn
    )
      throw new Error("secret metadata");
    try {
      await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    } catch (error) {
      if (error instanceof Error && error.name === "AccessDeniedException")
        continue;
      throw new Error("secret access verification");
    }
    throw new Error("secret access verification");
  }
  console.log("Runtime role denied master and migration secrets: PASS");
}

main().catch((error: unknown) => {
  console.error(
    `Database verification failed: ${error instanceof Error && ["configuration", "permissions", "secret metadata", "secret access verification"].includes(error.message) ? error.message : "runtime check"}`,
  );
  process.exitCode = 1;
});

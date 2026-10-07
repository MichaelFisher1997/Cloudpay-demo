import { pool, secret } from "../src/server/db";
import { required } from "../src/server/config";
import { migrate } from "../src/server/jobs";
import { approvedDevReset } from "../src/server/dev-reset";

async function main() {
  const reset = approvedDevReset(process.env);
  const region = required(process.env.AWS_REGION, "AWS_REGION");
  const credentials = await secret(
    required(process.env.MIGRATION_SECRET_ARN, "MIGRATION_SECRET_ARN"),
    region,
  );
  const db = pool(
    required(process.env.DATABASE_HOST, "DATABASE_HOST"),
    Number(process.env.DATABASE_PORT ?? 5432),
    process.env.DATABASE_NAME ?? "godiffy",
    { username: credentials.username!, password: credentials.password! },
  );
  try {
    await migrate(db, { resetDevData: reset });
    console.log("Schema migrated");
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Migration failed:",
    error instanceof Error ? error.name : "unknown",
  );
  process.exitCode = 1;
});

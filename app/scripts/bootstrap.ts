import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { pool, secret } from "../src/server/db";
import { required } from "../src/server/config";
import { bootstrap, type SecretStore } from "../src/server/jobs";

async function main() {
  const region = required(process.env.AWS_REGION, "AWS_REGION");
  const master = await secret(
    required(process.env.MASTER_SECRET_ARN, "MASTER_SECRET_ARN"),
    region,
  );
  const db = pool(
    required(process.env.DATABASE_HOST, "DATABASE_HOST"),
    Number(process.env.DATABASE_PORT ?? 5432),
    process.env.DATABASE_NAME ?? "godiffy",
    { username: master.username!, password: master.password! },
  );
  const sm = new SecretsManagerClient({ region });
  const store: SecretStore = {
    async get(id) {
      try {
        const response = await sm.send(
          new GetSecretValueCommand({ SecretId: id }),
        );
        return response.SecretString ? JSON.parse(response.SecretString) : null;
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "ResourceNotFoundException"
        )
          return null;
        throw error;
      }
    },
    async put(id, value) {
      await sm.send(
        new PutSecretValueCommand({
          SecretId: id,
          SecretString: JSON.stringify(value),
        }),
      );
    },
  };
  try {
    await bootstrap(db, store, process.env.DATABASE_NAME ?? "godiffy", {
      runtime: required(process.env.DATABASE_SECRET_ARN, "DATABASE_SECRET_ARN"),
      migration: required(
        process.env.MIGRATION_SECRET_ARN,
        "MIGRATION_SECRET_ARN",
      ),
    });
    console.log("Database roles and secret containers initialized");
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Bootstrap failed:",
    error instanceof Error ? error.name : "unknown",
  );
  process.exitCode = 1;
});

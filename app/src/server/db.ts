import { Pool } from "pg";
import { readFileSync } from "node:fs";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { config } from "./config";
export const caPath = "/etc/ssl/certs/rds-global-bundle.pem";
export async function secret(
  arn: string,
  region: string,
): Promise<Record<string, string>> {
  const result = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: arn }),
  );
  if (!result.SecretString) throw new Error("Secret string unavailable");
  return JSON.parse(result.SecretString) as Record<string, string>;
}
export function pool(
  host: string,
  port: number,
  database: string,
  credentials: { username: string; password: string },
  localUrl?: string,
): Pool {
  const db = new Pool(
    localUrl
      ? { connectionString: localUrl, max: 5 }
      : {
          host,
          port,
          database,
          user: credentials.username,
          password: credentials.password,
          max: 5,
          ssl: { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true },
          connectionTimeoutMillis: 5000,
        },
  );
  // pg emits idle connection errors on Pool, not on an outstanding query.
  // Never print the error object: it may contain connection details.
  db.on("error", () => console.error("Idle PostgreSQL connection failed"));
  return db;
}
let instance: Promise<{ db: Pool }> | undefined;
export function runtime() {
  return (instance ??= (async () => {
    const c = config();
    const credentials = c.localUrl
      ? { username: "", password: "" }
      : await secret(c.secretArn, c.region);
    return {
      db: pool(
        c.host,
        c.port,
        c.database,
        { username: credentials.username!, password: credentials.password! },
        c.localUrl,
      ),
    };
  })().catch((error) => {
    instance = undefined;
    throw error;
  }));
}

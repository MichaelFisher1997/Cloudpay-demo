import { config } from "../src/server/config";

try {
  config();
} catch {
  console.error("Invalid application configuration");
  process.exitCode = 1;
}

import { config } from "../src/server/config";
import { authSettings } from "../src/server/auth";

try {
  config();
  authSettings();
} catch {
  console.error("Invalid application configuration");
  process.exitCode = 1;
}

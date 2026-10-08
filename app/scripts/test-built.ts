import { resolve } from "node:path";

const app = resolve(import.meta.dir, "..");
if (!(await Bun.file(resolve(app, ".output/server/index.mjs")).exists())) {
  throw new Error(
    "Build the app before running the local built-artifact smoke test",
  );
}
// The repository's local-only runner owns its uniquely named PG17 container.
// This process never receives AWS credentials or prints ephemeral test secrets.
const runner = Bun.spawn(["bun", "scripts/test-database.ts"], {
  cwd: app,
  env: { ...process.env, BUILT_SMOKE: "1" },
  stdout: "inherit",
  stderr: "inherit",
});
if ((await runner.exited) !== 0) process.exitCode = 1;

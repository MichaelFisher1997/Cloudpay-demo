import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import scope from "./scope.json";
import { assertDestroyPlan, assertExecutionContext, assertFingerprint, identities, type Plan, type ResourceIdentity } from "./guards";

process.umask(0o077);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mode = process.argv[2] ?? "";
const summary = process.env.GITHUB_STEP_SUMMARY;

class CommandFailure extends Error {
  readonly code: string | undefined;
  constructor(program: string, operation: string, stderr: string) {
    super(`${program} ${operation} failed: ${stderr.slice(-6000)}`);
    this.code = stderr.match(/\(([^)]+)\) when calling/)?.[1];
  }
}

function note(message: string): void {
  console.log(message);
  if (summary) appendFileSync(summary, `${message}\n`);
}

function run(program: string, args: string[], cwd = source): string {
  try {
    return execFileSync(program, args, {
      cwd,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 45 * 60 * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() ?? "Command interrupted or timed out";
    // Never echo command stdout: it may contain raw state or a JSON plan.
    throw new CommandFailure(program, args.slice(0, 2).join(" "), stderr);
  }
}

function aws<T>(service: string, operation: string, args: string[] = []): T {
  const output = run("aws", [service, operation, ...args, "--region", scope.region, "--output", "json", "--no-cli-pager"]);
  return output.trim() ? JSON.parse(output) as T : {} as T;
}

function optionalAws<T>(service: string, operation: string, args: string[], absent: string[]): T | undefined {
  try {
    return aws<T>(service, operation, args);
  } catch (error) {
    if (error instanceof CommandFailure && error.code && absent.includes(error.code)) return undefined;
    throw error;
  }
}

function terraform(directory: string, args: string[]): string {
  return run("terraform", [`-chdir=${directory}`, ...args]);
}

function privateJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

function removeTemporaryGuards(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) removeTemporaryGuards(file);
    else if (entry.name.endsWith(".tf")) {
      const original = readFileSync(file, "utf8");
      const temporary = original.replace(/\bprevent_destroy\s*=\s*true\b/g, "prevent_destroy = false");
      if (temporary !== original) writeFileSync(file, temporary, { mode: 0o600 });
    }
  }
}

function assertDeliveryFrozen(): void {
  for (const workflow of ["dev-deploy.yml", "dev-image.yml"]) {
    const path = `repos/${scope.repository}/actions/workflows/${workflow}`;
    if (run("gh", ["api", path, "--jq", ".state"]).trim() !== "disabled_manually") {
      throw new Error(`Delivery workflow is not disabled: ${workflow}`);
    }
    for (const status of ["in_progress", "queued", "waiting", "pending", "requested"]) {
      const count = Number(run("gh", ["api", `${path}/runs?status=${status}&per_page=1`, "--jq", ".total_count"]).trim());
      if (!Number.isFinite(count) || count !== 0) throw new Error(`Delivery workflow still has ${status} runs: ${workflow}`);
    }
  }
}

function assertBucket(bucket: string, environment: string): void {
  const result = aws<{ TagSet: Array<{ Key: string; Value: string }> }>("s3api", "get-bucket-tagging", ["--bucket", bucket, "--expected-bucket-owner", scope.account]);
  const tags = new Map(result.TagSet.map((tag) => [tag.Key, tag.Value]));
  if (tags.get("Project") !== "godiffy" || tags.get("Environment") !== environment) {
    throw new Error(`Bucket ownership tags differ from the approved scope: ${bucket}`);
  }
}

function assertNoBackendLocks(): void {
  for (const environment of ["bootstrap", "dev", "prod"]) {
    const lock = optionalAws("s3api", "head-object", ["--bucket", scope.stateBucket, "--key", `godiffy/${environment}/terraform.tfstate.tflock`, "--expected-bucket-owner", scope.account], ["404", "NoSuchKey", "NotFound"]);
    if (lock) throw new Error(`A current ${environment} backend lock exists; never force-unlock during retirement`);
  }
}

function createPlan(directory: string, name: string, approved: ResourceIdentity[], targets: string[] = []): string {
  const file = join(directory, `${name}.tfplan`);
  const vars = directory.endsWith("/dev") ? ["-var-file=release.tfvars.json"] : [];
  terraform(directory, ["plan", "-destroy", "-input=false", "-no-color", "-lock-timeout=120s", ...vars, ...targets.map((target) => `-target=${target}`), `-out=${file}`]);
  const plan = JSON.parse(terraform(directory, ["show", "-json", file])) as Plan;
  const deletions = assertDestroyPlan(plan, approved);
  note(`- ${name}: ${deletions.length} approved Terraform deletions; no creates, updates or replacements.`);
  for (const address of deletions) console.log(`  delete ${address}`);
  return file;
}

interface Versions {
  Versions?: Array<{ Key?: string; VersionId?: string }>;
  DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
}

function clearBucket(bucket: string, environment: string, temporary: string): void {
  assertBucket(bucket, environment);
  const args = ["--bucket", bucket, "--expected-bucket-owner", scope.account];
  const uploads = aws<{ Uploads?: Array<{ Key: string; UploadId: string }> }>("s3api", "list-multipart-uploads", args);
  for (const upload of uploads.Uploads ?? []) {
    aws("s3api", "abort-multipart-upload", [...args, "--key", upload.Key, "--upload-id", upload.UploadId]);
  }
  const inventory = aws<Versions>("s3api", "list-object-versions", args);
  const objects = [...(inventory.Versions ?? []), ...(inventory.DeleteMarkers ?? [])];
  if (objects.some((object) => !object.Key || !object.VersionId)) throw new Error("S3 deletion inventory lacks an exact version ID");
  if (bucket === scope.stateBucket && objects.some((object) => !object.Key!.startsWith("godiffy/"))) {
    throw new Error("The state bucket contains an unapproved non-Godiffy object prefix");
  }
  for (let offset = 0; offset < objects.length; offset += 1000) {
    const file = join(temporary, "object-version-batch.json");
    privateJson(file, { Objects: objects.slice(offset, offset + 1000).map(({ Key, VersionId }) => ({ Key, VersionId })), Quiet: true });
    const result = aws<{ Errors?: unknown[] }>("s3api", "delete-objects", [...args, "--delete", `file://${file}`]);
    if (result.Errors?.length) throw new Error("S3 refused one or more exact object-version deletions");
  }
  const remaining = aws<Versions>("s3api", "list-object-versions", args);
  const remainingUploads = aws<{ Uploads?: unknown[] }>("s3api", "list-multipart-uploads", args);
  if (remaining.Versions?.length || remaining.DeleteMarkers?.length || remainingUploads.Uploads?.length) {
    throw new Error(`Bucket is not empty after exact-version cleanup: ${bucket}`);
  }
  note(`- Emptied ${bucket}: ${objects.length} exact object/marker versions and ${(uploads.Uploads ?? []).length} multipart uploads.`);
}

function clearContainerImages(temporary: string): void {
  const args = ["--registry-id", scope.account, "--repository-name", scope.containerRepository];
  let previous = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = aws<{ imageIds?: Array<{ imageDigest: string }> }>("ecr", "list-images", args);
    const digests = [...new Set((result.imageIds ?? []).map((image) => image.imageDigest))];
    if (!digests.length) {
      note("- Dedicated ECR repository is empty (tagged and untagged images checked).");
      return;
    }
    if (digests.length >= previous) throw new Error("ECR image deletion made no progress; inspect manifest dependencies");
    previous = digests.length;
    for (let offset = 0; offset < digests.length; offset += 100) {
      const file = join(temporary, "image-digest-batch.json");
      privateJson(file, digests.slice(offset, offset + 100).map((imageDigest) => ({ imageDigest })));
      const deleted = aws<{ failures?: Array<{ failureCode?: string }> }>("ecr", "batch-delete-image", [...args, "--image-ids", `file://${file}`]);
      if (deleted.failures?.some((failure) => failure.failureCode !== "ImageReferencedByManifestList")) {
        throw new Error("ECR refused one or more approved image-digest deletions");
      }
    }
  }
  throw new Error("ECR cleanup exceeded its bounded manifest-dependency retries");
}

function stopApplication(): void {
  const resource = `service/${scope.cluster}/${scope.service}`;
  const target = aws<{ ScalableTargets?: unknown[] }>("application-autoscaling", "describe-scalable-targets", ["--service-namespace", "ecs", "--resource-ids", resource, "--scalable-dimension", "ecs:service:DesiredCount"]);
  if (target.ScalableTargets?.length) {
    aws("application-autoscaling", "deregister-scalable-target", ["--service-namespace", "ecs", "--resource-id", resource, "--scalable-dimension", "ecs:service:DesiredCount"]);
  }
  const result = optionalAws<{ services?: Array<{ status: string }> }>("ecs", "describe-services", ["--cluster", scope.cluster, "--services", scope.service], ["ClusterNotFoundException"]);
  if (result?.services?.some((service) => service.status !== "INACTIVE")) {
    aws("ecs", "update-service", ["--cluster", scope.cluster, "--service", scope.service, "--desired-count", "0"]);
    aws("ecs", "wait", ["services-stable", "--cluster", scope.cluster, "--services", scope.service]);
    const tasks = aws<{ taskArns?: string[] }>("ecs", "list-tasks", ["--cluster", scope.cluster]);
    for (const task of tasks.taskArns ?? []) aws("ecs", "stop-task", ["--cluster", scope.cluster, "--task", task, "--reason", "Owner-approved complete Godiffy retirement"]);
    if (tasks.taskArns?.length) aws("ecs", "wait", ["tasks-stopped", "--cluster", scope.cluster, "--tasks", ...tasks.taskArns]);
  }
  note("- Application tasks stopped and autoscaling disabled before data deletion.");
}

function deleteDatabase(): void {
  const database = optionalAws<{ DBInstances?: Array<{ DbiResourceId: string; DeletionProtection: boolean; DBInstanceStatus: string }> }>("rds", "describe-db-instances", ["--db-instance-identifier", scope.database], ["DBInstanceNotFound"]);
  if (!database?.DBInstances?.length) return;
  const instance = database.DBInstances[0]!;
  if (instance.DbiResourceId !== scope.databaseResourceId) throw new Error("Database resource ID changed since approval");
  if (instance.DBInstanceStatus !== "deleting") {
    if (instance.DeletionProtection) {
      aws("rds", "modify-db-instance", ["--db-instance-identifier", scope.database, "--no-deletion-protection", "--apply-immediately"]);
      aws("rds", "wait", ["db-instance-available", "--db-instance-identifier", scope.database]);
    }
    note("- Deleting the approved database WITHOUT a final snapshot and WITH automated-backup deletion.");
    aws("rds", "delete-db-instance", ["--db-instance-identifier", scope.database, "--skip-final-snapshot", "--delete-automated-backups"]);
  }
  aws("rds", "wait", ["db-instance-deleted", "--db-instance-identifier", scope.database]);
}

function deleteTaskDefinitionHistory(): void {
  const definitions: string[] = [];
  for (const family of scope.taskFamilies) {
    const active = aws<{ taskDefinitionArns?: string[] }>("ecs", "list-task-definitions", ["--family-prefix", family, "--status", "ACTIVE"]);
    // This API has no resource-level IAM support. The owner separately approved
    // exact-ARN human SSO deregistration; never broaden the runner to Resource:*.
    if (active.taskDefinitionArns?.length) throw new Error("Approved task revisions must be deregistered through the separately approved exact-ARN SSO step before Actions deletes their history");
    const inactive = aws<{ taskDefinitionArns?: string[] }>("ecs", "list-task-definitions", ["--family-prefix", family, "--status", "INACTIVE"]);
    definitions.push(...(inactive.taskDefinitionArns ?? []));
  }
  for (let offset = 0; offset < definitions.length; offset += 10) {
    const result = aws<{ failures?: unknown[] }>("ecs", "delete-task-definitions", ["--task-definitions", ...definitions.slice(offset, offset + 10)]);
    if (result.failures?.length) throw new Error("ECS refused task-definition history deletion");
  }
  note(`- Requested permanent deletion of ${definitions.length} inactive task definitions; AWS may retain DELETE_IN_PROGRESS metadata temporarily.`);
}

function assertAbsent<T>(service: string, operation: string, args: string[], absent: string[]): void {
  if (optionalAws<T>(service, operation, args, absent) !== undefined) throw new Error(`Resource still exists: ${service} ${operation}`);
}

function verifyRetirement(includeIam = true): void {
  assertAbsent("rds", "describe-db-instances", ["--db-instance-identifier", scope.database], ["DBInstanceNotFound"]);
  const snapshots = aws<{ DBSnapshots?: unknown[] }>("rds", "describe-db-snapshots", ["--db-instance-identifier", scope.database]);
  if (snapshots.DBSnapshots?.length) throw new Error("Godiffy database snapshots remain");
  const backups = optionalAws<{ DBInstanceAutomatedBackups?: unknown[] }>("rds", "describe-db-instance-automated-backups", ["--dbi-resource-id", scope.databaseResourceId], ["DBInstanceAutomatedBackupNotFound"]);
  if (backups?.DBInstanceAutomatedBackups?.length) throw new Error("Godiffy automated backups remain");
  const vpcs = aws<{ Vpcs?: unknown[] }>("ec2", "describe-vpcs", ["--filters", `Name=vpc-id,Values=${scope.vpc}`]);
  if (vpcs.Vpcs?.length) throw new Error("Approved Godiffy VPC still exists");
  assertAbsent("ecr", "describe-repositories", ["--registry-id", scope.account, "--repository-names", scope.containerRepository], ["RepositoryNotFoundException"]);
  assertAbsent("elbv2", "describe-load-balancers", ["--load-balancer-arns", scope.loadBalancerArn], ["LoadBalancerNotFound"]);
  if (includeIam) {
    for (const role of scope.roles) assertAbsent("iam", "get-role", ["--role-name", role], ["NoSuchEntity"]);
    for (const policy of scope.policies) assertAbsent("iam", "get-policy", ["--policy-arn", `arn:aws:iam::${scope.account}:policy/${policy}`], ["NoSuchEntity"]);
  }
  for (const family of scope.taskFamilies) {
    const active = aws<{ taskDefinitionArns?: unknown[] }>("ecs", "list-task-definitions", ["--family-prefix", family, "--status", "ACTIVE"]);
    if (active.taskDefinitionArns?.length) throw new Error("Runnable Godiffy task definitions remain");
  }
  const clusters = aws<{ clusterArns?: string[] }>("ecs", "list-clusters");
  if (clusters.clusterArns?.includes(`arn:aws:ecs:${scope.region}:${scope.account}:cluster/${scope.cluster}`)) throw new Error("Godiffy ECS cluster remains");
  const alarms = aws<{ MetricAlarms?: unknown[]; CompositeAlarms?: unknown[] }>("cloudwatch", "describe-alarms", ["--alarm-name-prefix", "godiffy-dev-"]);
  if (alarms.MetricAlarms?.length || alarms.CompositeAlarms?.length) throw new Error("Godiffy CloudWatch alarms remain");
  for (const prefix of ["/ecs/godiffy-dev-", "/aws/rds/instance/godiffy-dev-"]) {
    const logs = aws<{ logGroups?: unknown[] }>("logs", "describe-log-groups", ["--log-group-name-prefix", prefix]);
    if (logs.logGroups?.length) throw new Error("Godiffy log groups remain");
  }
  assertAbsent("sns", "get-topic-attributes", ["--topic-arn", `arn:aws:sns:${scope.region}:${scope.account}:godiffy-dev-alarms`], ["NotFound"]);
  for (const arn of scope.secretArns) {
    const secret = optionalAws<{ DeletedDate?: string }>("secretsmanager", "describe-secret", ["--secret-id", arn], ["ResourceNotFoundException"]);
    if (secret && !secret.DeletedDate) throw new Error("A project secret is not scheduled for deletion");
    note(`- Secret ${arn.split(":secret:")[1]}: ${secret ? `scheduled for deletion ${secret.DeletedDate}` : "deleted"}.`);
  }
  note(`- Verified database, snapshots, backups, VPC, ECR, ALB, ECS, ${includeIam ? "project IAM, " : ""}alarms, logs and SNS retirement.`);
}

function main(): void {
  assertExecutionContext(process.env, mode);
  const caller = aws<{ Account: string; Arn: string }>("sts", "get-caller-identity");
  if (caller.Account !== scope.account || !caller.Arn.startsWith(`arn:aws:sts::${scope.account}:assumed-role/${scope.runnerRole}/`)) {
    throw new Error("Retirement requires the exact approved AWS account and temporary runner role");
  }
  assertDeliveryFrozen();
  if (scope.resumeAfterApplicationRetirement) {
    assertAbsent("s3api", "head-bucket", ["--bucket", scope.imagesBucket, "--expected-bucket-owner", scope.account], ["404", "NoSuchBucket", "NotFound"]);
    verifyRetirement(false);
  } else {
    assertBucket(scope.imagesBucket, "dev");
  }
  assertBucket(scope.stateBucket, "bootstrap");
  assertNoBackendLocks();
  const temporary = mkdtempSync(join(process.env.RUNNER_TEMP ?? "/tmp", "godiffy-retirement-"));
  cpSync(join(source, "terraform"), join(temporary, "terraform"), {
    recursive: true,
    filter: (path) => !path.split("/").includes(".terraform") && !/\.tfstate(?:\.|$)|\.tfplan(?:\.|$)/.test(path),
  });
  cpSync(join(source, "aws/ci"), join(temporary, "aws/ci"), { recursive: true });
  removeTemporaryGuards(join(temporary, "terraform"));
  const dev = join(temporary, "terraform/environments/dev");
  const bootstrap = join(temporary, "terraform/bootstrap");
  // The backend bucket cannot safely store the state of its own deletion.
  rmSync(join(bootstrap, "backend.tf"));
  terraform(dev, ["init", "-input=false", "-lockfile=readonly", "-backend-config=backend.hcl"]);
  const rawDev = terraform(dev, ["state", "pull"]);
  writeFileSync(join(temporary, "dev-before.tfstate"), rawDev, { mode: 0o600 });
  const approvedDev = identities(JSON.parse(rawDev));
  assertFingerprint(approvedDev, scope.devStateFingerprint);
  const bootstrapFile = join(bootstrap, "terraform.tfstate");
  aws("s3api", "get-object", ["--bucket", scope.stateBucket, "--key", "godiffy/bootstrap/terraform.tfstate", "--expected-bucket-owner", scope.account, bootstrapFile]);
  const approvedBootstrap = identities(JSON.parse(readFileSync(bootstrapFile, "utf8")));
  assertFingerprint(approvedBootstrap, scope.bootstrapStateFingerprint);
  const prodFile = join(temporary, "prod-before.tfstate");
  const prod = optionalAws("s3api", "get-object", ["--bucket", scope.stateBucket, "--key", "godiffy/prod/terraform.tfstate", "--expected-bucket-owner", scope.account, prodFile], ["NoSuchKey"]);
  if (prod && identities(JSON.parse(readFileSync(prodFile, "utf8"))).length) throw new Error("Unexpected deployed production resources; stop");
  terraform(bootstrap, ["init", "-input=false", "-lockfile=readonly"]);
  note(`# Godiffy retirement — ${mode} — ${process.env.GITHUB_SHA}`);
  note(`- Verified approved inventory: ${approvedDev.length} DEV and ${approvedBootstrap.length} bootstrap resource identities.`);
  createPlan(dev, "preflight-full-dev", approvedDev);
  const bootstrapPlan = createPlan(bootstrap, "bootstrap-retirement", approvedBootstrap);
  if (mode === "plan") {
    note(scope.resumeAfterApplicationRetirement
      ? "- Resuming only the verified remaining slice: delete inactive task history, dedicated IAM and all backend versions/bucket; application/data retirement is already independently verified."
      : "- Additional approved steps: stop tasks; delete PostgreSQL without final/retained automated backups; purge both versioned buckets and ECR; delete inactive task history and the old deployment role.");
    note("- No application/data deletions were executed. Private plans/state were not uploaded.");
    return;
  }
  assertDeliveryFrozen();
  if (!scope.resumeAfterApplicationRetirement) {
    stopApplication();
    deleteDatabase();
    const applicationResources = approvedDev.filter(({ address }) => address.startsWith("module.godiffy.") || address === "aws_secretsmanager_secret.smoke");
    const applicationPlan = createPlan(dev, "application-retirement", applicationResources, ["module.godiffy", "aws_secretsmanager_secret.smoke"]);
    clearBucket(scope.imagesBucket, "dev", temporary);
    clearContainerImages(temporary);
    note("- Applying the guarded application retirement plan.");
    terraform(dev, ["apply", "-input=false", "-no-color", applicationPlan]);
  }
  deleteTaskDefinitionHistory();
  const iamPlan = createPlan(dev, "dev-iam-retirement", approvedDev);
  terraform(dev, ["apply", "-input=false", "-no-color", iamPlan]);
  const remainder = identities(JSON.parse(terraform(dev, ["state", "pull"])));
  if (remainder.length) throw new Error("DEV Terraform state still tracks resources");
  const attached = aws<{ AttachedPolicies?: unknown[] }>("iam", "list-attached-role-policies", ["--role-name", scope.deploymentRole]);
  const inline = aws<{ PolicyNames?: unknown[] }>("iam", "list-role-policies", ["--role-name", scope.deploymentRole]);
  if (attached.AttachedPolicies?.length || inline.PolicyNames?.length) throw new Error("Unexpected deployment-role policies remain; do not detach unrelated policies");
  aws("iam", "delete-role", ["--role-name", scope.deploymentRole]);
  verifyRetirement();
  // No further operation uses the remote backend after this point.
  assertNoBackendLocks();
  clearBucket(scope.stateBucket, "bootstrap", temporary);
  terraform(bootstrap, ["apply", "-input=false", "-no-color", bootstrapPlan]);
  for (const bucket of [scope.imagesBucket, scope.stateBucket]) {
    assertAbsent("s3api", "head-bucket", ["--bucket", bucket, "--expected-bucket-owner", scope.account], ["404", "NoSuchBucket", "NotFound"]);
  }
  note("- Both dedicated S3 buckets are absent. No Godiffy database snapshots or retained automated backups remain.");
  note("- Remove the temporary runner role through SSO after this job completes. Shared OIDC, SSO, service-linked roles and unrelated resources were not deleted.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Retirement stopped on an unknown failure");
  process.exitCode = 1;
}

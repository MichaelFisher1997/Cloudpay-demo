"""Retain only the healthy, uninitialized DEV DB after its failed post-create read."""
from datetime import datetime, timezone
import json
import subprocess

NAME = "godiffy-dev-postgres"
ADDRESS = "module.godiffy.module.database.aws_db_instance.this"
TAGS = {"Project": "godiffy", "Environment": "dev", "ManagedBy": "terraform", "Purpose": "cloudpay-technical-assessment"}


def read(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError("Read-only DB repair verification failed")
    return json.loads(result.stdout)


def aws(*args):
    return read(["aws", "--region", "eu-west-2", "--no-cli-pager", *args, "--output", "json"])


def main():
    identity = aws("sts", "get-caller-identity")
    if identity["Account"] != "218549829565" or ":assumed-role/cloudpay-demo-github-actions/" not in identity["Arn"]:
        raise RuntimeError("Repair must use the exact DEV Actions identity")
    state = read(["terraform", "-chdir=terraform/environments/dev", "state", "pull"])
    resources = state.get("resources", [])
    if any(resource["type"] in ("aws_ecs_service", "aws_ecs_task_definition") for resource in resources):
        raise RuntimeError("Do not repair after jobs/service definitions exist")
    matches = [resource for resource in resources if resource.get("module") == "module.godiffy.module.database" and resource["type"] == "aws_db_instance" and resource["name"] == "this"]
    if len(matches) != 1 or len(matches[0]["instances"]) != 1:
        raise RuntimeError("Expected exact failed-new DEV DB state record")
    instance = matches[0]["instances"][0]
    if instance.get("status") != "tainted" or instance["attributes"]["identifier"] != NAME:
        raise RuntimeError("Expected failed post-create read taint")
    database = aws("rds", "describe-db-instances", "--db-instance-identifier", NAME)["DBInstances"][0]
    age = datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(database["InstanceCreateTime"]).timestamp()
    if not 0 <= age < 6 * 3600 or database["DBInstanceStatus"] != "available":
        raise RuntimeError("Only recent, healthy failed-new DEV DB is repairable")
    if database["DBName"] != "godiffy" or database["DBInstanceClass"] != "db.t4g.micro" or database["PubliclyAccessible"] or database["MultiAZ"] or not database["StorageEncrypted"] or not database["DeletionProtection"]:
        raise RuntimeError("Wrong dedicated DB shape/protections")
    tags = aws("rds", "list-tags-for-resource", "--resource-name", database["DBInstanceArn"])["TagList"]
    if {tag["Key"]: tag["Value"] for tag in tags} != TAGS:
        raise RuntimeError("Wrong database ownership")
    for name in ("godiffy-dev-runtime", "godiffy-dev-migration"):
        metadata = aws("secretsmanager", "describe-secret", "--secret-id", name)
        if metadata.get("VersionIdsToStages"):
            raise RuntimeError("Application credentials exist; do not repair initialized DB")
    for desired in ("RUNNING", "STOPPED"):
        tasks = aws("ecs", "list-tasks", "--cluster", "godiffy-dev-cluster", "--desired-status", desired)["taskArns"]
        if tasks:
            raise RuntimeError("Application jobs/tasks exist; do not repair initialized DB")
    subprocess.run(["terraform", "-chdir=terraform/environments/dev", "untaint", ADDRESS], check=True, timeout=120)
    print("Verified recent healthy DEV DB, empty app-secret containers and no jobs/tasks; retained DB by repairing failed-read taint without deletion.")


if __name__ == "__main__":
    main()

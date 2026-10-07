"""Repair only the newly created, empty DEV DB log group's failed-read taint.

This retains the physical log group; no AWS resource or data is deleted. Explicitly
selected Actions repair proves recent creation, ownership and empty log streams.
"""
from datetime import datetime, timezone
import json
import subprocess

NAME = "/aws/rds/instance/godiffy-dev-postgres/postgresql"
ARN = f"arn:aws:logs:eu-west-2:218549829565:log-group:{NAME}"
ADDRESS = "module.godiffy.module.database.aws_cloudwatch_log_group.postgresql"
TAGS = {"Project": "godiffy", "Environment": "dev", "ManagedBy": "terraform", "Purpose": "cloudpay-technical-assessment"}


def read(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError("Read-only repair verification failed")
    return json.loads(result.stdout)


def aws(*args):
    return read(["aws", "--region", "eu-west-2", "--no-cli-pager", *args, "--output", "json"])


def main():
    identity = aws("sts", "get-caller-identity")
    if identity["Account"] != "218549829565" or ":assumed-role/cloudpay-demo-github-actions/" not in identity["Arn"]:
        raise RuntimeError("Repair must use the exact DEV Actions identity")
    state = read(["terraform", "-chdir=terraform/environments/dev", "state", "pull"])
    matches = [resource for resource in state.get("resources", []) if resource.get("module") == "module.godiffy.module.database" and resource["type"] == "aws_cloudwatch_log_group" and resource["name"] == "postgresql"]
    if len(matches) != 1 or len(matches[0]["instances"]) != 1:
        raise RuntimeError("Expected the exact failed newly created DEV log-group record")
    instance = matches[0]["instances"][0]
    if instance.get("status") != "tainted" or instance["attributes"]["name"] != NAME:
        raise RuntimeError("Expected failed-read taint; ordinary resources must not be repaired")
    groups = aws("logs", "describe-log-groups", "--log-group-name-prefix", NAME)["logGroups"]
    if len(groups) != 1 or groups[0]["logGroupName"] != NAME:
        raise RuntimeError("Unexpected log group")
    group = groups[0]
    age = datetime.now(timezone.utc).timestamp() - group["creationTime"] / 1000
    if not 0 <= age < 6 * 3600 or group.get("storedBytes", 0) != 0:
        raise RuntimeError("Only a recent, empty failed-new DEV create is repairable")
    if aws("logs", "list-tags-for-resource", "--resource-arn", ARN)["tags"] != TAGS:
        raise RuntimeError("Wrong ownership")
    if aws("logs", "describe-log-streams", "--log-group-name", NAME)["logStreams"]:
        raise RuntimeError("Do not alter a log group containing streams/data")
    # Keep the actual resource. A normal refreshed plan converges retention/tags.
    subprocess.run(["terraform", "-chdir=terraform/environments/dev", "untaint", ADDRESS], check=True, timeout=120)
    print("Verified empty, recent, dedicated log group; repaired failed-read state taint without deleting any resource/data.")


if __name__ == "__main__":
    main()
